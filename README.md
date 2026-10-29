# TrendLens — ติดตามและวิเคราะห์หุ้นเทคสหรัฐฯ (ใช้งานส่วนตัวบน localhost)

โปรแกรมดูกราฟและราคาที่อัปเดตต่อเนื่อง ประเมินแนวโน้ม แสดงสัญญาณ “พิจารณาซื้อ / ออกจากสถานะ / รอ” พร้อมเหตุผล
ทดสอบกลยุทธ์ย้อนหลัง และจำลองติดตามสถานะ — **ไม่มีการส่งคำสั่งซื้อขายจริง ไม่เชื่อมบัญชีเทรด ไม่ deploy ขึ้นอินเทอร์เน็ต**

> ผลทั้งหมดเป็นกติกาที่อธิบายได้และผลจำลอง ไม่ใช่คำแนะนำการลงทุน และไม่รับประกันผลในอนาคต

เอกสารภาพรวมโครงการฉบับวางแผน (ภาษาอังกฤษ): [docs/PROJECT_OVERVIEW.en.md](docs/PROJECT_OVERVIEW.en.md)

---

## สารบัญ

1. [สถาปัตยกรรม](#สถาปัตยกรรม)
2. [สมมติฐานที่เลือกเอง](#สมมติฐานที่เลือกเอง)
3. [ติดตั้งบน Windows (PowerShell)](#ติดตั้งบน-windows-powershell)
4. [เปิด Demo Mode](#เปิด-demo-mode)
5. [ตั้งค่า provider (Alpaca)](#ตั้งค่า-provider-alpaca)
6. [รันโปรแกรมบน 127.0.0.1](#รันโปรแกรมบน-127001)
7. [รัน tests](#รัน-tests)
8. [การประเมินแนวโน้ม](#การประเมินแนวโน้ม)
9. [กลยุทธ์เริ่มต้น](#กลยุทธ์เริ่มต้น)
10. [Backtesting](#backtesting)
11. [ข้อมูลสดและนโยบายข้อมูล](#ข้อมูลสดและนโยบายข้อมูล)
12. [ข้อจำกัดของข้อมูล / feed](#ข้อจำกัดของข้อมูล--feed)
13. [การตั้งค่าทั้งหมด](#การตั้งค่าทั้งหมด)
14. [ความเป็นส่วนตัว](#ความเป็นส่วนตัว)
15. [โครงสร้างโปรเจกต์](#โครงสร้างโปรเจกต์)
16. [ผลการทดสอบและสิ่งที่ยังทดสอบไม่ได้](#ผลการทดสอบและสิ่งที่ยังทดสอบไม่ได้)
17. [ข้อจำกัดที่ยังเหลือ](#ข้อจำกัดที่ยังเหลือ)

---

## สถาปัตยกรรม

```
                    ┌──────────────────────────── เครื่องของคุณ ─────────────────────────────┐
 Alpaca REST/WS ───►│  worker (Node.js, tsx)                    Next.js (127.0.0.1:3000)     │
 (หรือ Demo)        │   provider → bounded queue → SQLite ◄────►  /api/*  ◄── เบราว์เซอร์     │
                    │   backfill / reconnect / สัญญาณ        (WAL)  หน้าจอ poll ทุก ~2 วินาที │
                    └────────────────────────────────────────────────────────────────────────┘
```

- **worker** (`worker/index.ts`) — โปรเซสแยก รับ WebSocket ครั้งเดียว (ไม่ผูกกับการ refresh หน้าจอ), ใส่ข้อมูลเข้า queue ที่จำกัดขนาด,
  บันทึกลง SQLite, เติมช่วงที่ขาดหลัง reconnect, ประเมินสัญญาณจาก **แท่งที่ปิดแล้วเท่านั้น** และเขียนสถานะ/heartbeat ให้ UI
  worker **ไม่เปิด port ใด ๆ** — สื่อสารกับ Next.js ผ่าน SQLite
- **Next.js App Router** — หน้าจอ + HTTP API อ่าน/เขียน SQLite, bind ที่ `127.0.0.1` เท่านั้น
- **โค้ดกลาง** (`src/core`) — indicators, trend, strategy, engine จำลองสถานะ และ backtest เป็นชุดเดียวกัน
  ใช้ทั้งใน worker (สด), API (แสดงผล) และหน้า Backtest — tests ยืนยันว่าสัญญาณสดตรงกับ backtest บนข้อมูลเดียวกัน
- **คำสั่งเดียว** เปิดทั้งสองโปรเซสด้วย `concurrently`
- กราฟใช้ [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/) (Apache-2.0) และแสดงโลโก้ attribution ของไลบรารีตามเงื่อนไขการใช้งาน

## สมมติฐานที่เลือกเอง

| เรื่อง | สิ่งที่เลือก | เหตุผล |
|---|---|---|
| ภาษา/stack | **TypeScript ทั้งโปรเจกต์** (Next.js + Node worker) ตามหัวข้อ “ใช้ TypeScript ทั้งโปรเจกต์” | คำสั่งบางส่วนกล่าวถึง Python/Streamlit ซึ่งขัดกับ stack ที่ระบุ จึงยึด stack ที่ระบุชัด; “Streamlit rerun” ตีความเป็น “การ refresh หน้าจอ” และ “virtual environment” เทียบได้กับ `node_modules` ภายในโปรเจกต์ (`npm ci`) |
| SQLite driver | `better-sqlite3` (มี prebuilt binary สำหรับ Windows/Node 24 ไม่ต้องติดตั้ง Visual Studio) | เร็ว, synchronous, รองรับ WAL ให้ 2 โปรเซสอ่าน/เขียนพร้อมกัน |
| WebSocket client | `WebSocket` ในตัวของ Node 22+ | ลด dependency |
| Feed เริ่มต้น | Alpaca `iex` | ใช้ได้กับแผนฟรี; ป้ายกำกับชัดว่าครอบคลุมเฉพาะ IEX |
| การปรับราคาย้อนหลัง | `split` | ข้อมูลสดเป็นราคาดิบ (ฐานหุ้นปัจจุบัน) จึงเข้ากันกับย้อนหลังที่ปรับ split; ไม่ปรับเงินปันผลเพื่อไม่ให้ราคาย้อนหลังต่ำกว่าราคาสดแบบไม่สม่ำเสมอ |
| Session | `regular` (09:30–16:00 ET) | ใช้เหมือนกันทั้งกราฟ กลยุทธ์ และ backtest |
| ATR | simple average ของ True Range | ค่าไม่ขึ้นกับจุดเริ่มของหน้าต่างข้อมูล → สดกับ backtest ได้ค่าเดียวกัน |
| “ออกข้าง” normalized | หารด้วย ATR14 | ใช้ได้ทุก timeframe โดยไม่ต้องตั้งเกณฑ์ % แยก |
| สัญญาณสดติดตาม | เฉพาะ 5 นาที (ปรับได้) | ตามค่าเริ่มต้นของกลยุทธ์ |
| เงินจำลอง | $10,000, ใช้ 100% ต่อการเข้า, ค่าธรรมเนียม 0.1%/ขา, slippage 0.05%/ขา, หุ้นเศษส่วน | ค่าที่สมเหตุสมผลสำหรับนักลงทุนรายย่อย ปรับได้ |
| Demo Mode | ข้อมูลสังเคราะห์จาก seed คงที่ + นาฬิกาจำลอง (เริ่ม 2026-10-01 10:00 ET, เร็ว 10 เท่า, ข้ามช่วงตลาดปิด) | ทำซ้ำได้ และดูการอัปเดตสดได้แม้ตลาดจริงปิด |
| ปฏิทินตลาด | วันหยุด/วันปิดเร็ว NYSE แบบคงที่ถึงปี 2027 | ไม่ต้องเรียกบริการภายนอก |
| Watchlist สูงสุด | 30 ตัว | ตามข้อจำกัด WebSocket ของ Alpaca แผนฟรี |

## ติดตั้งบน Windows (PowerShell)

ต้องมี **Node.js 22.12 ขึ้นไป** (ทดสอบบน Node 24.19 / npm 11.17, Windows 11)

```powershell
# ตรวจเวอร์ชัน
node --version
npm --version

# เข้าโฟลเดอร์โปรเจกต์
cd D:\Code\projects\TrandLens

# "virtual environment" ของ Node = node_modules ภายในโปรเจกต์ ติดตั้งตาม package-lock.json แบบล็อกเวอร์ชัน
npm ci

# (ไม่บังคับ) สร้างไฟล์ตั้งค่า
Copy-Item .env.example .env
Copy-Item trendlens.config.example.json trendlens.config.json
```

> `package.json` ตั้ง `allowScripts` ให้ **ไม่** รัน `node-gyp rebuild` ของ better-sqlite3 (ใช้ prebuilt binary ที่มากับแพ็กเกจ)
> ถ้ารันสคริปต์นี้บนเครื่องที่ไม่มี Visual Studio Build Tools จะติดตั้งไม่ผ่าน

## เปิด Demo Mode

ไม่ต้องมี API key:

```powershell
npm run demo
```

แล้วเปิดเบราว์เซอร์ที่ <http://127.0.0.1:3000> — ทุกหน้าจะมีป้าย **DEMO** สีเหลือง และเวลาเป็น “เวลาจำลอง”
หยุดโปรแกรมด้วย `Ctrl+C` ในหน้าต่าง PowerShell เดียวกัน

- ถ้าไม่มี `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` คำสั่ง `npm run dev` ก็จะเข้า Demo Mode อัตโนมัติพร้อมแจ้งเหตุผล
- ทดสอบการหลุด/เชื่อมต่อใหม่: `$env:DEMO_DROP_EVERY_SEC=60; npm run demo` (หลุด 15 วินาทีทุก 60 วินาที แล้ว backfill)
- เริ่ม Demo ใหม่ทั้งหมด: หยุดโปรแกรมแล้วลบ `data\trendlens.db*` (จะลบบันทึกส่วนตัวด้วย)

**Flow ที่ตรวจแล้ว:** เปิด Demo → เลือกหุ้นจาก Watchlist → ดูกราฟ → อ่านเหตุผลสัญญาณในกล่อง “สัญญาณและเหตุผล” →
พิมพ์บันทึก (Ctrl+Enter) → ปิดแล้วเปิดโปรแกรมใหม่ บันทึกยังอยู่ → หน้า “ทดสอบย้อนหลัง” → รัน Backtest

## ตั้งค่า provider (Alpaca)

1. สมัคร/เข้าสู่ระบบ Alpaca แล้วสร้าง API key (Paper หรือ Live ใช้ Market Data ได้เหมือนกัน — โปรแกรมนี้ใช้เฉพาะ Market Data)
2. แก้ไฟล์ `.env` (สร้างจาก `.env.example`):

```powershell
Copy-Item .env.example .env
notepad .env
```

```ini
DATA_PROVIDER=alpaca
ALPACA_API_KEY_ID=ใส่_key_id
ALPACA_API_SECRET_KEY=ใส่_secret
ALPACA_FEED=iex          # แผนฟรี; ใช้ sip เมื่อมี Algo Trader Plus; delayed_sip = ล่าช้า 15 นาที
ALPACA_ADJUSTMENT=split
```

3. รัน `npm run dev` แล้วดูแผง “สถานะ Provider” ทางซ้าย:
   - `LIVE · IEX` = real-time แต่เฉพาะ IEX, `LIVE · SIP` = ทุกตลาด, `DELAYED 15m` = ล่าช้า
   - ถ้า key ผิด/ไม่มีสิทธิ์ feed จะเห็นสถานะ “ผิดพลาด” พร้อมข้อความ และ worker จะไม่ลองเชื่อมต่อซ้ำจนกว่าจะแก้ `.env` แล้วเริ่มใหม่

> secret ถูกอ่านเฉพาะใน worker/server เท่านั้น (ไม่มีตัวแปร `NEXT_PUBLIC_`) ไม่ถูกส่งไปหน้าเว็บ ไม่ถูกเขียนลง log และ `.env` อยู่ใน `.gitignore`

ข้อมูลของแต่ละ provider/feed/วิธีปรับราคาเก็บในชุดข้อมูลแยกกัน (เช่น `demo`, `alpaca-iex-split`) จึงไม่ผสมกัน

## รันโปรแกรมบน 127.0.0.1

```powershell
# โหมดพัฒนา (hot reload) — Next.js + worker
npm run dev

# โหมด production
npm run build
npm start
```

ทุกคำสั่ง bind Next.js ที่ `127.0.0.1:3000` (`-H 127.0.0.1`) ซึ่งเข้าถึงได้จากเครื่องนี้เท่านั้น — worker ไม่เปิด port
ตรวจสอบได้ด้วย `netstat -ano | Select-String ":3000"` ควรเห็น `127.0.0.1:3000 ... LISTENING` (ไม่ใช่ `0.0.0.0`)

ถ้าต้องการรัน worker แยก: `npm run worker` (หรือ `npx tsx worker/index.ts --demo`)

## รัน tests

```powershell
npm test            # vitest — ไม่ต้องมี API key และไม่ต่อเครือข่าย
npm run typecheck   # tsc --noEmit
```

## การประเมินแนวโน้ม

ฟังก์ชัน `classifyTrendAt()` ใน `src/core/trend.ts` แยกจาก UI ใช้เฉพาะแท่ง 0..i และพารามิเตอร์จาก config
**MA50 หมายถึง 50 แท่งของ timeframe นั้น** (เช่น 5 นาที = 250 นาที, รายวัน = 50 วันทำการ) หน้าจอแสดงแนวโน้มแยก 1 นาที / 5 นาที / รายวัน

ลำดับการตรวจ (เงื่อนไขแรกที่เป็นจริงคือผลลัพธ์):

| ลำดับ | ผลลัพธ์ | เงื่อนไข (ค่าเริ่มต้น) |
|---|---|---|
| 1 | ข้อมูลไม่เพียงพอ | ไม่มี MA50, MA50 เมื่อ 10 แท่งก่อน หรือ ATR14 (ต้องมีอย่างน้อย 60 แท่ง) |
| 2 | ออกข้าง | \|MA50 − MA50[10 แท่งก่อน]\| / ATR14 **< 0.5** และ \|Close − MA50\| / ATR14 **≤ 1.0** |
| 3 | ขาขึ้น | Close > MA50 และ MA50 > MA50[10 แท่งก่อน] |
| 4 | ขาลง | Close < MA50 และ MA50 < MA50[10 แท่งก่อน] |
| 5 | ยังไม่ชัดเจน | นอกเหนือจากนี้ (เงื่อนไขขัดแย้งกัน) |

“ออกข้าง” ตรวจก่อน “ขาขึ้น/ขาลง” เพราะ MA ที่ชันน้อยมากเทียบกับความผันผวนไม่ควรนับเป็นแนวโน้ม
ATR14 = ค่าเฉลี่ยอย่างง่ายของ True Range 14 แท่ง ปรับค่าได้ใน `trendlens.config.json` → `strategy.trend`

## กลยุทธ์เริ่มต้น

Long-only, timeframe 5 นาที (`src/core/strategy.ts`, `src/core/engine.ts`)

- **สัญญาณเข้า (พิจารณาซื้อ):** ไม่มีสถานะ + แนวโน้มขาขึ้น + Close **>** High สูงสุดของ 20 แท่งก่อนหน้า
- **สัญญาณออก (ออกจากสถานะ):** มีสถานะ + Close **<** Low ต่ำสุดของ 10 แท่งก่อนหน้า — หมายถึงปิด long ไม่ใช่เปิด short
- **นอกนั้น:** รอ
- High/Low ย้อนหลัง **ไม่รวมแท่งปัจจุบัน**
- สัญญาณยืนยันใช้ **เฉพาะแท่งที่ปิดแล้ว** (เวลาสิ้นสุดแท่ง + 15 วินาที grace) — ระหว่างแท่งหน้าจอแสดงป้าย **“รอยืนยัน”** และไม่บันทึก
- จำลอง execution ที่ **ราคาเปิดของแท่งถัดไป** (+slippage, +ค่าธรรมเนียม)
- **เหตุการณ์สัญญาณ** (`signal_events`) แยกจาก **สถานะจำลอง** (`sim_positions`) — สัญญาณบันทึกแบบ unique ต่อ (ชุดข้อมูล, หุ้น, TF, กลยุทธ์, เวลาแท่ง, ชนิด) จึงไม่ซ้ำเมื่อ refresh/restart
- ทุกสัญญาณเก็บเหตุผลและค่าตัวแปร (Close, High/Low อ้างอิง, MA, ATR, ความชัน, ระยะห่าง, RSI)
- RSI14 แสดงเป็นข้อมูลประกอบเท่านั้น ไม่อยู่ในเงื่อนไข และไม่มีการแสดง “% โอกาสกำไร/ความมั่นใจ”
- ครั้งแรกที่ worker เห็นหุ้น/TF/ชุดพารามิเตอร์ใหม่ จะไล่สัญญาณจากข้อมูลย้อนหลังที่มี (ที่มา = `backfill`) แล้วติดตามต่อ (`live`; ถ้าตามเก็บหลายแท่งหลังข้อมูลขาด = `catchup`)
- เปลี่ยนพารามิเตอร์ → strategy key ใหม่ → ประวัติสัญญาณ/สถานะจำลองชุดใหม่ (ไม่ปนกับของเดิม)

## Backtesting

หน้า “ทดสอบย้อนหลัง” ใช้ `prepare/evaluateAt/step` ชุดเดียวกับระบบสด

- ไม่มี look-ahead: indicator ที่แท่ง i ใช้แท่ง 0..i; ตัดแท่งหลังวันสิ้นสุดก่อนคำนวณ; ไม่ใช้แท่งที่ยังไม่ปิด
- แท่งก่อนวันเริ่มใช้เป็น warm-up ของ indicator เท่านั้น
- เงินสดไม่ติดลบ, ไม่มี leverage (สัดส่วนเงินถูกจำกัดที่ 100%), ไม่เปิดสถานะซ้อน, เงินไม่พอ → ข้ามและบันทึกเหตุผล
- **หุ้นเศษส่วน (ค่าเริ่มต้น):** ปัดจำนวนลงที่ 6 ตำแหน่ง สมมติว่าโบรกเกอร์รองรับ fractional และ fill ได้ทั้งหมดที่ราคาเปิด+slippage; ปิดตัวเลือกนี้เพื่อใช้จำนวนเต็ม
- ค่าธรรมเนียม = % ของมูลค่า + ค่าคงที่ ต่อขา (ค่าธรรมเนียมขายไม่เกินมูลค่าที่ขายได้)
- Metrics: equity curve (mark-to-market ที่ราคาปิด), total return, max drawdown, จำนวนเทรด, win rate (กำไร > 0 นับเป็นชนะ), profit factor
- **Buy-and-hold** ช่วงเดียวกัน ซื้อที่ราคาเปิดแท่งแรกของช่วง ด้วยสัดส่วนเงิน ค่าธรรมเนียม และ slippage เดียวกัน
- กรณีพิเศษ: ไม่มีเทรด (แจ้งชัด, win rate/profit factor = “-”), ไม่มีเทรดขาดทุน (profit factor คำนวณไม่ได้ พร้อมหมายเหตุ),
  สถานะยังเปิดตอนจบ (แสดง mark-to-market แยก + ประมาณการต้นทุนขาย ซึ่งยังไม่หักใน total return), สัญญาณที่แท่งสุดท้าย (แจ้งว่ายัง execute ไม่ได้)
- **In-sample / Out-of-sample:** ใส่วันเริ่มช่วง OOS → แยกผลสองช่วง แต่ละช่วงเริ่มเงินใหม่ ไม่ถือสถานะข้ามช่วง (OOS ใช้แท่งก่อนหน้าเป็น warm-up ได้)
- **การปรับราคา:** แสดงวิธีปรับราคาของชุดข้อมูลทุกครั้ง — Alpaca ตาม `ALPACA_ADJUSTMENT` (ค่าเริ่มต้น split เท่านั้น ⇒ ผลตอบแทนไม่รวมเงินปันผล),
  Demo = ไม่มี corporate action, CSV = “ไม่ทราบ (ตามไฟล์ต้นทาง)” — ชุดข้อมูลแต่ละแบบเก็บแยก ไม่ผสมกัน
- รายการซื้อขายและบันทึกการ execute ตรวจสอบย้อนได้ทุกรายการ (เวลาสัญญาณ, เวลา execute, ราคาเปิด, ราคาหลัง slippage, ค่าธรรมเนียม, เงินสดคงเหลือ)

### นำเข้า CSV

หน้า “ข้อมูล / CSV” — คอลัมน์ `Date, Open, High, Low, Close, Volume` (ลำดับใดก็ได้)
`YYYY-MM-DD` = รายวัน, มีเวลา = 1 นาที (ไม่มี offset ⇒ ถือเป็นเวลานิวยอร์ก) แถวซ้ำใช้แถวหลัง แถวผิดรูปแบบถูกข้ามและรายงาน
ข้อมูล CSV เก็บในชุดข้อมูล `csv` ใช้ได้ในหน้า Backtest

## ข้อมูลสดและนโยบายข้อมูล

| หัวข้อ | การทำงาน |
|---|---|
| Connection | worker สร้าง WebSocket ครั้งเดียว; หน้าจอ refresh ไม่สร้าง connection ใหม่ |
| Queue | `BoundedQueue` ขนาด `STREAM_QUEUE_CAPACITY` (20,000) — เต็มแล้วทิ้งรายการเก่าสุด, นับจำนวน และสั่ง backfill ชดเชย |
| อัปเดตหน้าจอ | poll ทุก `UI_REFRESH_MS` (2,000 ms) ดึงเฉพาะแท่งใหม่ (`since=`) |
| Reconnect | exponential backoff 1s, 2s, 4s … สูงสุด 60s ±20% jitter; error 402/409 (key/สิทธิ์) หยุดลองและแจ้ง |
| Backfill | จำจุดสุดท้ายก่อนหลุด → หลังเชื่อมต่อใหม่ดึง REST ตั้งแต่จุดนั้น (ทับซ้อน 5 นาที) ก่อนประเมินสัญญาณต่อ |
| ข้อมูลซ้ำ | เวลาเดียวกัน ค่าเดิม → ข้าม (นับ “ซ้ำ”) |
| ข้อมูลแก้ไขย้อนหลัง | เวลาเดียวกัน ค่าต่าง (`updatedBars`, backfill) → ค่าใหม่แทนที่ (นับ “แก้ไข”) — สัญญาณที่ยืนยันไปแล้ว **ไม่ถูกแก้/ลบ** (เก็บค่าที่ใช้ตัดสินใจไว้ในเหตุการณ์) |
| ข้อมูลมาผิดลำดับ | แทรกตามเวลา (นับ “มาช้า”) แต่ไม่ย้อนสร้างสัญญาณของแท่งที่ประเมินไปแล้ว |
| ข้อมูลผิดรูปแบบ | NaN, ราคา ≤ 0, High < Low → ทิ้ง |
| เวลา | เก็บเป็น UTC (epoch ms) แสดงผลเลือก Asia/Bangkok หรือ America/New_York ได้ที่มุมขวาบน; แท่งรายวันแสดงวันที่ของตลาด |
| ตลาดปิด vs ข้อมูลค้าง | ตลาดปิด (ตามปฏิทิน NYSE) = “ตลาดปิด (ไม่ใช่ข้อมูลค้าง)”; ตลาดเปิดแต่ไม่มีข้อมูลเกิน `STALE_AFTER_SEC` = “ข้อมูลค้าง” |
| พักสัญญาณ | เมื่อ หลุด / ค้าง / กำลัง backfill / provider error — หน้าจอแสดงเหตุผล; worker ไม่มี heartbeat > 10 วินาที ⇒ ป้าย `WORKER OFFLINE` |
| Session | `MARKET_SESSION` ใช้กับการกรองแท่งนาทีทั้งกราฟ กลยุทธ์ และ backtest |

## ข้อจำกัดของข้อมูล / feed

ตรวจสอบกับเอกสาร Alpaca (docs.alpaca.markets) ณ ต.ค. 2026:

- **Basic (ฟรี):** real-time เฉพาะ **IEX exchange** (ส่วนน้อยของปริมาณซื้อขายทั้งตลาด ⇒ ราคา/volume อาจต่างจากตลาดรวม และบางนาทีไม่มีแท่ง),
  WebSocket ได้ 30 symbols, REST 200 ครั้ง/นาที, ข้อมูลย้อนหลัง SIP ล่าสุด 15 นาทีขอไม่ได้
- **Algo Trader Plus:** SIP ทุกตลาด real-time
- `delayed_sip` = SIP ล่าช้า 15 นาที — โปรแกรมแสดงเป็น **DELAYED** ไม่เรียกว่า real-time
- แท่งนาทีของ Alpaca รวม pre/after-hours — โปรแกรมกรองตาม session ที่ตั้งไว้
- แท่งรายวันย้อนหลังและ `dailyBars` มาจาก provider ตามนิยามของ Alpaca (อาจรวมการซื้อขายนอกเวลาปกติ) — ไม่ได้สร้างใหม่จากแท่งนาที
- ข้อมูลสด (WebSocket) เป็นราคาดิบเสมอ; ย้อนหลังปรับตาม `ALPACA_ADJUSTMENT` — ถ้าเกิด split ระหว่างที่โปรแกรมเปิดอยู่ ให้ลบชุดข้อมูลแล้ว backfill ใหม่
- Demo: ข้อมูลสังเคราะห์ ไม่ใช่ราคาจริง มีเฉพาะ regular session

## การตั้งค่าทั้งหมด

- **ตัวแปรสภาพแวดล้อม** — ดูคำอธิบายทุกตัวใน [`.env.example`](.env.example)
- **กติกา/เงินจำลอง** — `trendlens.config.json` (คัดลอกจาก [`trendlens.config.example.json`](trendlens.config.example.json)):
  `session`, `strategyTimeframes` (เช่น `["5Min","1Day"]`), `strategy` (lookback, MA, ATR, เกณฑ์ออกข้าง), `portfolio` (เงินตั้งต้น, สัดส่วน, ค่าธรรมเนียม, slippage, fractional)
- แก้แล้วต้องเริ่มโปรแกรมใหม่ (worker อ่านค่าตอนเริ่ม) — หน้า Backtest ปรับพารามิเตอร์ต่อการรันได้โดยไม่กระทบระบบสด

## ความเป็นส่วนตัว

- Next.js bind ที่ `127.0.0.1` เท่านั้น, worker ไม่เปิด port, ไม่มี deploy/tunnel/telemetry ของโปรแกรม
- Next.js ปิด `poweredByHeader`; ไม่โหลดฟอนต์/สคริปต์จากภายนอก (ใช้ฟอนต์ของระบบ)
- ข้อมูลทั้งหมด (ราคา, สัญญาณ, สถานะจำลอง, บันทึก, watchlist) อยู่ใน `data/trendlens.db` ภายในโปรเจกต์
- `.env`, `data/`, `*.db*`, log และ `trendlens.config.json` อยู่ใน `.gitignore`
- การเชื่อมต่อเครือข่ายของ worker มีเฉพาะ `data.alpaca.markets` และ `stream.data.alpaca.markets` (เมื่อใช้ Alpaca)
- หมายเหตุ: Next.js อาจส่ง telemetry แบบไม่ระบุตัวตนของตัวเฟรมเวิร์ก ปิดได้ด้วย `npx next telemetry disable`

## โครงสร้างโปรเจกต์

```
app/                     Next.js App Router (UI)
  page.tsx               แดชบอร์ด: Watchlist, กราฟ, แนวโน้ม, สัญญาณ, บันทึก
  backtest/ positions/ data/   หน้า Backtest, สถานะจำลอง, นำเข้า CSV
  api/                   HTTP API: status, chart, signals, notes, watchlist, positions, backtest, import-csv, datasets
src/core/                logic กลาง (ไม่มี I/O ใช้ได้ทั้ง client/server/tests)
  config.ts              ค่าเริ่มต้นและการ merge config
  indicators.ts          SMA, RSI (Wilder), ATR, highest/lowest ก่อนหน้า
  trend.ts               จัดประเภทแนวโน้ม
  strategy.ts            กติกาเข้า/ออก/รอ + preview “รอยืนยัน”
  engine.ts              จำลองคำสั่ง/สถานะ (execution แท่งถัดไป, ค่าธรรมเนียม, slippage)
  backtest.ts            backtest, metrics, buy-and-hold, IS/OOS
  aggregation.ts         รวมแท่ง, session, นโยบายซ้ำ/ผิดลำดับ/แก้ไข, การปิดแท่ง
  market.ts time.ts csv.ts hash.ts
src/server/              ฝั่ง server/worker เท่านั้น
  env.ts                 อ่าน environment/config (secret)
  db.ts                  SQLite schema + repository
  data.ts                โหลดแท่งตาม timeframe/session
  stream.ts              bounded queue + exponential backoff
  providers/             Data Provider interface, Alpaca (REST+WS), Demo
  live/runner.ts         ลูปของ worker (stream → queue → DB → สัญญาณ)
  live/tracker.ts        ติดตามสัญญาณ/สถานะจำลองแบบ incremental (ไม่ซ้ำ)
src/components/          React components (กราฟ Lightweight Charts, แผงต่าง ๆ)
worker/index.ts          จุดเริ่มของ worker
tests/                   vitest
```

## ผลการทดสอบและสิ่งที่ยังทดสอบไม่ได้

ทดสอบจริงบน Windows 11, Node 24.19.0 (29 ต.ค. 2026):

| รายการ | ผล |
|---|---|
| `npm ci` จาก lockfile บนเครื่องสะอาด (ไม่มี Visual Studio) | ผ่าน |
| `npm test` — 75 tests / 7 ไฟล์ | ผ่านทั้งหมด |
| `npm run typecheck` | ผ่าน |
| `npm run build` | ผ่าน ไม่มี warning |
| `npm audit` | 0 vulnerabilities (Next.js 16.4.3) |
| `npm run demo` → Next.js listen ที่ `127.0.0.1:3000` เท่านั้น | ตรวจด้วย netstat แล้ว |
| Flow Demo ในเบราว์เซอร์: เลือกหุ้น → กราฟ/MA/RSI/เครื่องหมาย → เหตุผลสัญญาณ → บันทึก note → restart → note ยังอยู่ → รัน Backtest (+OOS) | ผ่าน ไม่มี console error |
| สัญญาณที่ worker บันทึก (AAPL 5 นาที) เทียบกับ backtest บนข้อมูลเดียวกัน | ตรงกัน 40/40 |
| นาฬิกา Demo เดินต่อหลัง restart | ผ่าน |
| นำเข้า CSV + backtest ชุดข้อมูล CSV | ผ่าน |

Tests ครอบคลุม: indicator และ warm-up, การจัดประเภทแนวโน้ม (รวมลำดับการตรวจ), breakout ที่ไม่รวมแท่งปัจจุบัน, สัญญาณจากแท่งปิดเท่านั้น/preview รอยืนยัน,
การป้องกันสัญญาณซ้ำ (รวมกรณี state หาย), execution ที่แท่งถัดไป, ค่าธรรมเนียม/slippage/เงินสดไม่ติดลบ/ไม่ใช้ leverage/หุ้นจำนวนเต็ม,
no look-ahead, IS/OOS, การรวมแท่งและขอบเวลา (DST, วันหยุด, วันปิดเร็ว), ข้อมูลซ้ำ/ผิดลำดับ/แก้ไข/ผิดรูปแบบ/ช่วงขาด,
bounded queue, backoff, Demo determinism, worker + Demo แบบเร่งเวลา (รวมหลุด → พักสัญญาณ → reconnect → backfill เติมช่วงครบ),
protocol ของ Alpaca ด้วย WebSocket/fetch ปลอม (auth, subscribe, b/u/d/t, reconnect, error 402, แบ่งหน้า REST, ไม่ขอ 15 นาทีล่าสุดของ delayed)

**ยังทดสอบไม่ได้เพราะไม่มี credential:**

- การเชื่อมต่อ Alpaca จริง (auth, ข้อมูลสดจริง, REST ย้อนหลังจริง, ข้อจำกัด rate limit/connection limit จริง)
- รูปแบบ timestamp แท่งรายวันจริงของ Alpaca (โค้ดรองรับเที่ยงคืน ET และทดสอบด้วยข้อมูลตัวอย่าง)
- พฤติกรรมช่วงตลาดจริง (pre/after-hours, วันปิดเร็ว) กับ feed จริง
- **ไม่อ้างว่า live feed ทำงานแล้ว** จนกว่าจะทดสอบด้วย key จริง — ขั้นตอนแนะนำ: ใส่ key ใน `.env`, `npm run dev`, ดูแผงสถานะว่า “เชื่อมต่อแล้ว” และหน้า “ข้อมูล / CSV” มีชุด `alpaca-iex-split`

## ข้อจำกัดที่ยังเหลือ

- ปฏิทินวันหยุด NYSE เป็นรายการคงที่ถึงปี 2027 (ต้องเพิ่มเองหลังจากนั้น) และไม่รองรับการปิดตลาดฉุกเฉิน
- แนวโน้ม/สัญญาณคำนวณซ้ำทุก poll ของหน้าจอ (เร็วพอสำหรับ watchlist ขนาดเล็ก ไม่ได้ออกแบบสำหรับหลายร้อยตัว)
- ข้อมูลย้อนหลัง 1 นาทีเก็บ 30 วันเป็นค่าเริ่มต้น — backtest 1/5 นาทีจึงสั้น (เพิ่ม `INTRADAY_HISTORY_DAYS` ได้ แต่ IEX มีข้อมูลบางช่วง)
- ไม่ปรับราคาข้อมูลที่เก็บไว้แล้วอัตโนมัติเมื่อเกิด split ใหม่
- การหยุดด้วย `Ctrl+C` ปิดทั้งสองโปรเซส; ถ้าปิดหน้าต่าง terminal แบบอื่นบน Windows อาจเหลือ process ค้าง (ปิดใน Task Manager หรือ `Get-Process node`)
- สถานะจำลองสดใช้เงินตั้งต้นต่อหุ้น/TF แยกกัน ไม่ใช่พอร์ตรวม
