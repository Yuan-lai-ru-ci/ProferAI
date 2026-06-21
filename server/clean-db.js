const db = require("better-sqlite3")("./proma-team.db")
const before = db.prepare("SELECT count(*) as c FROM file_manifests").get().c
db.prepare("DELETE FROM file_manifests").run()
const after = db.prepare("SELECT count(*) as c FROM file_manifests").get().c
console.log("cleaned:", before, "->", after)
