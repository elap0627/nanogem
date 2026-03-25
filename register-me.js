import Database from 'better-sqlite3';
import path from 'path';

const myChatId = "123456789"; 
const db = new Database(path.join(process.cwd(), 'store', 'messages.db'));

try {
  db.exec(`DROP TABLE IF EXISTS registered_groups;`);

  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT,
      folder TEXT,
      trigger TEXT,
      added_at TEXT,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  db.prepare(`
    INSERT INTO registered_groups (jid, name, folder, trigger, added_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(myChatId, 'Master', 'main', '@wongi', new Date().toISOString());
  
  console.log(`✅ 텔레그램 채팅방 [${myChatId}] VIP 화이트리스트 완벽 등록 완료!`);
} catch (err) {
  console.error("❌ 등록 실패:", err.message);
}
