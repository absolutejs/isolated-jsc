// Worker: respond to several ops. Some succeed, the last rejects.
self.addEventListener("message", (event) => {
  const { id, op } = event.data as { id: number; op: string };
  if (op === "fail") {
    self.postMessage({ id, ok: false, error: "boom" });
  } else {
    self.postMessage({ id, ok: true, result: op });
  }
});
