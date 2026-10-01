# BPL CCTV Layout

เว็บแผนผังกล้อง CCTV ของ BPL — repo นี้มีเฉพาะโค้ดหน้าเว็บ ไม่มีข้อมูลผังหรือภาพกล้อง

- เข้าเว็บลิงก์เดียว เลือกไอดี ใส่รหัสผ่าน ระบบพาไปหน้าที่ตรงกับสิทธิ์
  - ไอดีหน้างาน → `view/` (ดูอย่างเดียว อัปเดตเองทุก ~20 วินาที)
  - ไอดีหลังบ้าน → `edit/` (แก้ไขแล้วกด **บันทึก** · ตั้ง/เปลี่ยนรหัสผ่านที่ปุ่ม **รหัสผ่าน**)
  - เครื่องที่เข้าแล้วจะจำไว้จนกว่ารหัสผ่านของไอดีนั้นจะถูกเปลี่ยน
- รหัสผ่านใช้ถอดรหัส GitHub token ที่เก็บแบบเข้ารหัสใน repo สาธารณะ `bpl-cctv-access` (`access.json`)
- ข้อมูลทั้งหมดอยู่ใน repo ส่วนตัวที่ระบุใน `assets/config.js`
  - branch `main`: `layout.json`, `images.json`, `default-layout.json`
  - branch `images`: ภาพกล้อง เขียนใหม่เป็น commit เดียวไม่มีประวัติทุกครั้งที่ภาพเปลี่ยน ภาพเก่าจึงไม่สะสม

## โครงสร้าง

- `index.html` — หน้ากรอกรหัส
- `view/index.html`, `edit/index.html` — หน้าเว็บ (dc-runtime template)
- `assets/bpl-store.js` — โมเดลเลเอ้า + การวาด
- `assets/bpl-cloud.js` — ซิงก์กับ repo ข้อมูลผ่าน GitHub API
- `assets/support.js`, `assets/styles.css` — runtime และ design system
