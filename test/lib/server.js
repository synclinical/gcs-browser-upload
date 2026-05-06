import express from "express";

let server = null;
let requests = [];
let file = null;
let baseURL = "";

const router = new express.Router();

router.use(express.text({ type: "*/*", limit: "10mb" }));

router.use((req, res, next) => {
  const range = req.headers["content-range"];
  if (!range) {
    req.range = null;
    next();
    return;
  }

  const matchKnown = range.match(/^bytes (\d+?)-(\d+?)\/(\d+?)$/);
  const matchUnknown = range.match(/^bytes \*\/(\d+?)$/);

  if (matchUnknown) {
    req.range = { known: false, total: parseInt(matchUnknown[1]) };
    next();
  } else if (matchKnown) {
    req.range = {
      known: true,
      start: parseInt(matchKnown[1]),
      end: parseInt(matchKnown[2]),
      total: parseInt(matchKnown[3]),
    };
    next();
  } else {
    res.status(400).send("No valid content-range header provided");
  }
});

router.use((req, res, next) => {
  requests.push({
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    body: req.body,
  });
  next();
});

router.put("/", (req, res) => {
  if (req.range === null) {
    res.status(200).json({ status: "ok" });
    return;
  }

  if (!file) {
    file = { total: req.range.total, index: 0 };
  }

  if (req.range.known) {
    file.index = req.range.end;
  }

  res.set("range", `bytes=0-${file.index}`);

  if (file.index + 1 >= file.total) {
    res.status(200).json({ status: "ok" });
  } else {
    res.status(308).send("Resume Incomplete");
  }
});

router.put("/fail", (_req, res) => {
  res.status(403).send("Forbidden");
});

router.put("/empty", (_req, res) => {
  res.status(200).send("");
});

// Returns 500 for first N requests, then succeeds (for retry testing)
let failCountdown = 0;
router.put("/fail-then-succeed", (req, res) => {
  if (failCountdown > 0) {
    failCountdown--;
    res.status(500).send("Transient Error");
    return;
  }

  if (req.range === null) {
    res.status(200).json({ status: "ok" });
    return;
  }

  if (!file) {
    file = { total: req.range.total, index: 0 };
  }
  if (req.range.known) {
    file.index = req.range.end;
  }
  res.set("range", `bytes=0-${file.index}`);
  if (file.index + 1 >= file.total) {
    res.status(200).json({ status: "ok" });
  } else {
    res.status(308).send("Resume Incomplete");
  }
});

// Always returns 410 Gone (expired session)
router.put("/expired", (_req, res) => {
  res.status(410).send("Gone");
});

export async function start() {
  const app = express();
  app.use("/file", router);

  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });

  const addr = server.address();
  baseURL = `http://localhost:${addr.port}`;
}

export function getBaseURL() {
  return baseURL;
}

export function resetServer() {
  requests = [];
  file = null;
  failCountdown = 0;
}

export function setFailCountdown(n) {
  failCountdown = n;
}

export function stop() {
  if (server) {
    server.close();
    server = null;
  }
}

export function getRequests() {
  return requests;
}
