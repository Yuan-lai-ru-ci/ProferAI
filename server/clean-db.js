import Database from 'better-sqlite3'
import { DB_PATH } from './src/config.js'

const db = new Database(DB_PATH)
const before = db.prepare('SELECT count(*) as c FROM file_manifests').get().c
db.prepare('DELETE FROM file_manifests').run()
const after = db.prepare('SELECT count(*) as c FROM file_manifests').get().c
console.log('cleaned:', before, '->', after)
db.close()
