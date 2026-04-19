// Pure JS fuzzy name matcher. Combines two measures so a single typo
// (Umayr vs Umaye) and a missing-token case (Umayr vs Umayr Sheik)
// both score high:
//
//   - Jaro-Winkler: good for typos, swapped chars, prefix matches
//   - token-set-sort: good for "same tokens, different order/extra tokens"
//
// Score = max of the two. Returns 0..1.

function normalize(s) {
  return (s ?? "")
    .toString()
    .normalize("NFKD")
    // strip diacritics
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(b.length - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix bonus (up to 4 chars, p=0.1)
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSort(a, b) {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;

  const intersection = new Set([...ta].filter((x) => tb.has(x)));
  const onlyA = [...ta].filter((x) => !tb.has(x)).sort();
  const onlyB = [...tb].filter((x) => !ta.has(x)).sort();
  const inter = [...intersection].sort();

  const s1 = inter.join(" ");
  const s2 = [...inter, ...onlyA].join(" ");
  const s3 = [...inter, ...onlyB].join(" ");

  return Math.max(
    jaroWinkler(s1, s2),
    jaroWinkler(s1, s3),
    jaroWinkler(s2, s3),
  );
}

export function fuzzyMatch({ name_a, name_b }) {
  const a = normalize(name_a);
  const b = normalize(name_b);
  if (!a || !b) return { score: 0, reason: "empty input" };

  const jw = jaroWinkler(a, b);
  const ts = tokenSetSort(a, b);

  if (ts >= jw) {
    return { score: Number(ts.toFixed(3)), reason: "token-set-sort dominated" };
  }
  return { score: Number(jw.toFixed(3)), reason: "jaro-winkler dominated" };
}
