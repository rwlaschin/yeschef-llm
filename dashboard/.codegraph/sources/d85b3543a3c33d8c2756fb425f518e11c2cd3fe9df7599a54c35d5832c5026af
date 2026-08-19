// Lexicographic order-key generator — port of the dnd project's lexBetween.
// Returns a key strictly between `a` and `b`:
//   - a==null  → a key before b
//   - b==null  → a key after a
//   - both null → middle of the alphabet
// Used to assign a prompt's per-type order on drag-drop (no hand-typed priorities).
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = ALPHABET.length

const toInts = (s: string) => s.split('').map((c) => ALPHABET.indexOf(c))
const toStr = (a: number[]) => a.map((i) => ALPHABET[i]).join('')
const onlyAlphabet = (s: string) => s.length > 0 && s.split('').every((c) => ALPHABET.includes(c))

function between(a: string, b: string): string {
  const aArr = toInts(a)
  const bArr = toInts(b)
  const res: number[] = []
  let i = 0
  while (true) {
    const ai = i < aArr.length ? aArr[i] : 0
    const bi = i < bArr.length ? bArr[i] : BASE - 1
    if (bi - ai > 1) { res.push(Math.floor((ai + bi) / 2)); break }
    res.push(ai)
    i++
  }
  return toStr(res)
}

export function lexBetween(a: string | null, b: string | null): string {
  if (a == null && b == null) return ALPHABET[Math.floor(BASE / 2)]
  // Legacy/non-alphabet keys: treat as missing bound so we never throw.
  const A = a != null && onlyAlphabet(a) ? a : null
  const B = b != null && onlyAlphabet(b) ? b : null
  if (A == null && B == null) return between(ALPHABET[0], ALPHABET[BASE - 1])
  if (A == null) return between(ALPHABET[0], B!)
  if (B == null) return between(A, ALPHABET[BASE - 1])
  return between(A, B)
}
