// QA measurement (analysis only). Parses pipe rows out of either a baseline Firestore dump
// (/tmp/baseline_*.json) or the probe log (/tmp/qa_run.log) and reports entree reuse + Kind.
//   node scripts/_qa_measure.mjs /tmp/qa_run.log
//   node scripts/_qa_measure.mjs /tmp/baseline_17aca751.json
import fs from 'fs'

const path = process.argv[2]
const raw = fs.readFileSync(path, 'utf8')

// units: [{label, text}]
let units = []
if (path.endsWith('.json')) {
  const j = JSON.parse(raw)
  const items = (j.plan || []).map((s) => s.items || [])
  units = j.docs.map((d) => ({
    label: `step${d.step}/unit${d.unit}/${JSON.stringify(items[d.step]?.[d.unit] ?? null)}`,
    step: d.step,
    item: items[d.step]?.[d.unit] ?? null,
    text: d.response,
  }))
} else {
  const parts = raw.split(/^@@@ STEP /m).slice(1)
  units = parts.map((p) => {
    const head = p.split('\n')[0]
    const m = /^(\d+) (\w+) UNIT (\d+) item=(\{.*?\})/.exec(head)
    return { label: head.trim(), step: Number(m?.[1]), item: m ? JSON.parse(m[4]) : null, text: p.slice(head.length) }
  })
}

// Header-driven: the baseline runs used Day|…|Fruit|Kind|Diets (no Course); the current step def
// uses Day|…|Fruit|Course|Kind. Index by the emitted header, never by fixed position.
function rows(text) {
  const cells = String(text).split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('|') && !/^\|?\s*-+/.test(l))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((c) => c.length >= 8)
  let hdr = null
  const out = []
  for (const c of cells) {
    if (/^day$/i.test(c[0])) { hdr = c.map((h) => h.toLowerCase()); continue }
    if (!hdr) continue
    const at = (name) => { const i = hdr.indexOf(name); return i < 0 ? '' : (c[i] || '') }
    out.push({ day: at('day'), mealtime: at('mealtime'), dish: at('dish'), course: at('course'), kind: at('kind').toLowerCase() })
  }
  return out
}

const all = []
for (const u of units) for (const r of rows(u.text)) all.push({ ...r, unit: u.label, step: u.step, diet: u.item?.diet ?? null })

const entrees = all.filter((r) => r.kind === 'entree')
const nonEntrees = all.filter((r) => r.kind !== 'entree')
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const distinctEntree = new Set(entrees.map((r) => norm(r.dish)))

console.log(`FILE ${path}`)
console.log(`units=${units.length} totalRows=${all.length} entreeRows=${entrees.length} distinctEntreeNames=${distinctEntree.size} ratio=${(distinctEntree.size / (entrees.length || 1)).toFixed(3)}`)
console.log(`entreeSlots(day×mealtime distinct)=${new Set(entrees.map((r) => `${r.day}|${r.mealtime}`)).size}`)

// Near-duplicate pairs: share >=1 distinctive token AND same head noun-ish token set overlap >=0.5
const names = [...distinctEntree]
const STOP = new Set(['with', 'and', 'the', 'a', 'of', 'in', 'on', 'served', 'style'])
const toks = (n) => new Set(n.split(' ').filter((w) => w.length > 2 && !STOP.has(w)))
const pairs = []
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const a = toks(names[i]), b = toks(names[j])
  const inter = [...a].filter((x) => b.has(x)).length
  const jac = inter / (new Set([...a, ...b]).size || 1)
  if (jac >= 0.4) pairs.push([jac.toFixed(2), names[i], names[j]])
}
console.log(`\nNEAR-DUPLICATE ENTREE PAIRS (jaccard>=0.40): ${pairs.length}`)
pairs.sort((x, y) => y[0] - x[0]).forEach((p) => console.log(`  ${p[0]}  "${p[1]}"  ~  "${p[2]}"`))

console.log(`\nENTREE NAMES (${names.length}), with row count:`)
const cnt = {}
entrees.forEach((r) => { cnt[norm(r.dish)] = (cnt[norm(r.dish)] || 0) + 1 })
Object.entries(cnt).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${String(c).padStart(3)}  ${n}`))

console.log(`\nKIND HISTOGRAM (non-entree rows: ${nonEntrees.length})`)
const kh = {}
nonEntrees.forEach((r) => { kh[r.kind || '(empty)'] = (kh[r.kind || '(empty)'] || 0) + 1 })
Object.entries(kh).sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`  ${String(c).padStart(4)}  ${k}`))

console.log('\nDISTINCT (Dish, Course, Kind) WHERE Kind=dessert:')
const des = new Map()
all.filter((r) => r.kind === 'dessert').forEach((r) => {
  const k = `${r.dish} | ${r.course} | ${r.kind}`
  des.set(k, (des.get(k) || 0) + 1)
})
;[...des.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}  ${k}`))

const SUSPECT = /\b(berries|berry|fruit cup|muffin|roll|bread|banana|orange|apple slices|melon|grapes|pear|peach|pineapple|cottage cheese|yogurt|biscuit|toast|cornbread)\b/i
const SWEET = /\b(sorbet|pudding|cobbler|cake|pie|sweetened|sugar|honey|syrup|custard|brownie|ice cream|gelatin|jello|tart|crisp|compote|baked apple|caramel|chocolate)\b/i
console.log('\nSUSPECT DESSERTS (plain fruit / bread / muffin still Kind=dessert):')
;[...des.keys()].filter((k) => SUSPECT.test(k.split('|')[0]) && !SWEET.test(k.split('|')[0])).forEach((k) => console.log(`  ${k}`))
console.log('\nSWEETS NOW FILED AS side/other (possible over-correction):')
all.filter((r) => r.kind !== 'dessert' && r.kind !== 'entree' && SWEET.test(r.dish))
  .map((r) => `${r.dish} | ${r.course} | ${r.kind}`)
  .filter((v, i, a) => a.indexOf(v) === i).forEach((v) => console.log(`  ${v}`))
