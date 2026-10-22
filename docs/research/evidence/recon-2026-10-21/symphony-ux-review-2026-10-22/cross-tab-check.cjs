const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const path =
  "/Users/kamogelo/.codex/worktrees/core-symphony/t3code/docs/design/symphony-exploration-2026-10-21/";
const storage = new Map();
function tab() {
  const ctx = vm.createContext({
    console,
    Date,
    Set,
    Map,
    JSON,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
      key: (i) => [...storage.keys()][i],
      get length() {
        return storage.size;
      },
    },
    NK: { icon: () => "", esc: (x) => String(x), toast: () => {}, onReady: () => {} },
    document: { getElementById: () => null },
  });
  ctx.window = ctx;
  for (const file of ["fixtures.js", "work-data.js"])
    vm.runInContext(fs.readFileSync(path + file, "utf8"), ctx);
  const source = fs.readFileSync(path + "work.js", "utf8").replace(
    /\}\)\(\);\s*$/,
    `render = () => {};
 window.audit={load, buildPreview,startDemo, changeDraft, get:()=>state};
})();`,
  );
  vm.runInContext(source, ctx);
  ctx.audit.load();
  return ctx.audit;
}
const a = tab(),
  b = tab();
a.changeDraft((d) => {
  d.selected = ["NEO-4830"];
});
b.changeDraft((d) => {
  d.selected = ["NEO-4830"];
});
a.get().preview = a.buildPreview();
b.get().preview = b.buildPreview();
assert.equal(a.get().preview.items[0].ready, true);
a.startDemo();
b.startDemo();
assert.equal(a.get().receipts[0].items[0].result, "accepted");
assert.equal(b.get().receipts[0].items[0].result, "accepted");
assert.equal(a.get().receipts[0].id, b.get().receipts[0].id);
console.log(
  "Confirmed: two isolated tab snapshots both accept NEO-4830 under the same receipt ID.",
);
storage.clear();
const c = tab(),
  d = tab();
c.changeDraft((x) => {
  x.selected = ["NEO-4830"];
});
d.changeDraft((x) => {
  x.selected = ["NEO-4833"];
});
c.get().preview = c.buildPreview();
d.get().preview = d.buildPreview();
c.startDemo();
d.startDemo();
const saved = JSON.parse(storage.get("neokod-symphony-proto:work:receipts"));
assert.equal(saved.length, 1);
assert.equal(saved[0].items[0].issueId, "NEO-4833");
console.log(
  "Confirmed: accepting different issues from stale snapshots overwrites the first receipt in the shared store.",
);
console.log(
  "Proof: exact prototype functions in two VM contexts with one in-memory localStorage stub; renderer replaced by no-op. No actual browser storage, provider, server, files or tracker were mutated by this check.",
);
