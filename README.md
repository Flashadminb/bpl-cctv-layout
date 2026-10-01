# BPL CCTV Layout

เว็บแผนผังกล้อง CCTV ของ BPL — repo นี้มีเฉพาะโค้ดหน้าเว็บ ไม่มีข้อมูลผังหรือภาพกล้อง

- เข้าเว็บลิงก์เดียว กรอกรหัส (GitHub token ของ repo ข้อมูล) ระบบพาไปหน้าที่ตรงกับสิทธิ์ของรหัส
  - รหัสอ่านอย่างเดียว → `view/` (หน้างาน ดูอย่างเดียว อัปเดตเองทุก ~20 วินาที)
  - รหัสอ่าน-เขียน → `edit/` (หลังบ้าน แก้ไขแล้วกด **บันทึก**)
- ข้อมูลทั้งหมดอยู่ใน repo ส่วนตัวที่ระบุใน `assets/config.js`
  - branch `main`: `layout.json`, `images.json`, `default-layout.json`
  - branch `images`: ภาพกล้อง เขียนใหม่เป็น commit เดียวไม่มีประวัติทุกครั้งที่ภาพเปลี่ยน ภาพเก่าจึงไม่สะสม

## โครงสร้าง

- `index.html` — หน้ากรอกรหัส
- `view/index.html`, `edit/index.html` — หน้าเว็บ (dc-runtime template)
- `assets/bpl-store.js` — โมเดลเลเอ้า + การวาด
- `assets/bpl-cloud.js` — ซิงก์กับ repo ข้อมูลผ่าน GitHub API
- `assets/support.js`, `assets/styles.css` — runtime และ design system
