import type { HelpAction, HelpAnswer, HelpCorpus, HelpDoc } from "./kb";

/**
 * Finds the parts of the corpus that fit a question and composes the answer
 * without a language model. Exactly the same rules as the server
 * (application/shared/help_assistant.py, app "console"): the same folding,
 * words, BM25 score, inflection and compound rules and the same answer. Both
 * are tested against the same questions (helpKbCases.json), so the local
 * answer and the server's say the same thing. Mirrors admin's retrieve.ts
 * with the console's English stopwords and texts.
 */

export const MIN_SCORE = 4;
export const CANDIDATES = 6;
const K1 = 1.2;
const B = 0.75;
const GUIDE_BOOST = 1.5;
const PHRASE_BONUS = 3;
const RELATED = 0.75;
/** At least this share of the question's words must be in the answer. */
const COVERAGE = 0.4;

// help_assistant.py _EN_STOP, word for word.
const STOPWORDS = new Set(
  ("the a an and or of to in on at for from by with is are was were be been it its this that these those " +
    "how do does did i we you my our your me us can could should would will where what which who when why " +
    "there here find see show get set change make use open add create turn up out off down into about " +
    "please tell any some all much many have has had").split(" "),
);

// help_assistant.py TEXTS["console"], byte for byte.
export const UNKNOWN_TEXT =
  "I'm not sure about that, so I'd rather not guess. Try asking another way, for example with the name of the page.";
export const REFUSE_TEXT =
  "I can't show or look up passwords, keys, tokens or secrets. Ask me how something in the console works instead.";
export const OWNER_TEXT = "That is not available to you.";
const OPEN = "Open";
const SHOW = "Show";
const UNDER = "is under";
const FALLBACK_WHERE = "the console";

/** Lower case, no accents, only letters and digits. */
export function fold(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokens(text: string): string[] {
  return fold(text)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** 1 the same word, 0.7 an inflection (invoice, invoices), 0.5 the start of a compound. */
export function matchWeight(q: string, d: string): number {
  if (q === d) return 1;
  const [short, long] = q.length <= d.length ? [q, d] : [d, q];
  const p = commonPrefix(short, long);
  if (short.length >= 4 && long.length - short.length <= 4 && p >= 4 && p >= short.length - 2) return 0.7;
  if (short.length >= 4 && long.startsWith(short)) return 0.5;
  return 0;
}

type Index = { docs: HelpDoc[]; tf: Map<string, number>[]; head: Set<string>[]; len: number[]; avg: number; df: Map<string, number>; phrases: string[][]; vocab: string[] };
const indexes = new WeakMap<HelpCorpus, Index>();

function index(corpus: HelpCorpus): Index {
  const hit = indexes.get(corpus);
  if (hit) return hit;
  const tf: Map<string, number>[] = [];
  const head: Set<string>[] = [];
  const len: number[] = [];
  const df = new Map<string, number>();
  const phrases: string[][] = [];
  for (const doc of corpus.docs) {
    const m = new Map<string, number>();
    const add = (text: string | undefined, w: number) => {
      for (const t of tokens(text ?? "")) m.set(t, (m.get(t) ?? 0) + w);
    };
    add(doc.title, 3);
    for (const k of doc.keywords ?? []) add(k, 3);
    add(doc.where, 1);
    // The title and keywords: at least one of the question's words must hit here.
    head.push(new Set(m.keys()));
    add(doc.text, 1);
    add(doc.answer, 1);
    tf.push(m);
    len.push([...m.values()].reduce((a, b) => a + b, 0));
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    phrases.push((doc.keywords ?? []).map(fold).filter((k) => k.includes(" ")));
  }
  const avg = len.reduce((a, b) => a + b, 0) / Math.max(len.length, 1);
  const vocab = [...df.keys()].filter((t) => t.length >= 4).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const built = { docs: corpus.docs, tf, head, len, avg, df, phrases, vocab };
  indexes.set(corpus, built);
  return built;
}

function idf(ix: Index, term: string): number {
  const n = ix.df.get(term) ?? 0;
  return Math.log(1 + (ix.docs.length - n + 0.5) / (n + 0.5));
}

/** The question's words, compounds split at a known word. */
function queryTokens(ix: Index, question: string): string[] {
  const out: string[] = [];
  for (const q of tokens(question)) {
    out.push(q);
    if (q.length < 8 || ix.df.has(q)) continue;
    const head = ix.vocab.find((d) => q.length - d.length >= 3 && q.startsWith(d));
    if (!head) continue;
    const rest = q.slice(head.length).replace(/^s(?=[^aeiouy])/, "");
    out.splice(out.length - 1, 1, head, ...(rest.length >= 3 ? [rest] : []));
  }
  return out;
}

/** The score and how many of the question's words the document has. */
export function score(ix: Index, i: number, question: string, qs = queryTokens(ix, question)): { score: number; covered: number; head: boolean } {
  const tf = ix.tf[i];
  const norm = K1 * (1 - B + (B * ix.len[i]) / ix.avg);
  let total = 0;
  let covered = 0;
  let inHead = false;
  for (const q of qs) {
    let best = 0;
    for (const [d, f] of tf) {
      const w = matchWeight(q, d);
      if (w === 0) continue;
      const s = (w * idf(ix, d) * f * (K1 + 1)) / (f + norm);
      if (s > best) best = s;
    }
    if (best > 0) covered += 1;
    if (!inHead) for (const d of ix.head[i]) if (matchWeight(q, d) > 0) inHead = true;
    total += best;
  }
  const folded = ` ${fold(question)} `;
  for (const p of ix.phrases[i]) if (folded.includes(` ${p} `)) total += PHRASE_BONUS;
  return { score: ix.docs[i].kind === "guide" ? total * GUIDE_BOOST : total, covered, head: inHead };
}

/**
 * The best matches first. Operators see every document (role "operator" on
 * the server), so nothing is filtered and nothing is hidden.
 */
export function candidates(corpus: HelpCorpus, question: string): { doc: HelpDoc; score: number }[] {
  const ix = index(corpus);
  const out: { doc: HelpDoc; score: number; i: number }[] = [];
  const qs = queryTokens(ix, question);
  const need = Math.max(1, Math.ceil(qs.length * COVERAGE));
  ix.docs.forEach((doc, i) => {
    const { score: s, covered, head } = score(ix, i, question, qs);
    if (s >= MIN_SCORE && covered >= need && head) out.push({ doc, score: s, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.slice(0, CANDIDATES).map(({ doc, score: s }) => ({ doc, score: s }));
}

const navigable = (doc: HelpDoc) => Boolean(doc.route) && !doc.route!.includes(":");

/** The button to the document's place; guides have their own buttons. */
export function docActions(doc: HelpDoc): HelpAction[] {
  if (doc.kind === "guide") return (doc.actions ?? []).map((a) => (a.highlight || !doc.highlight ? a : { ...a, highlight: doc.highlight }));
  if (!navigable(doc)) return [];
  return [{
    id: `go:${doc.id}`,
    label: `${doc.kind === "page" ? OPEN : SHOW} ${doc.title}`,
    to: doc.route!,
    ...(doc.hash ? { hash: doc.hash } : {}),
    ...(doc.highlight ? { highlight: doc.highlight } : {}),
  }];
}

/** Does the question ask for a secret? Then the assistant says no. */
export function isSecretQuestion(question: string): boolean {
  const q = ` ${fold(question)} `;
  const secret = / (losenord\w*|password\w*|api ?nyckel\w*|nyckel\w*|nycklar\w*|token\w*|hemlig\w*|secret\w*|pin ?kod\w*|kortnummer\w*|personnummer\w*|api key\w*|credential\w*) /;
  const show = / (vad ar|vilket ar|vilken ar|visa|ge mig|skicka|beratta|lista|kopiera|what is|what s|show|give me|send|tell me|list|copy|reveal) /;
  const others = / andra (restauranger|restaurangers|kunder|kunders|foretag) /;
  return (secret.test(q) && show.test(q)) || others.test(q);
}

/** "Where do I see ..." wants the place, not the number. */
export function isWhereQuestion(question: string): boolean {
  const q = ` ${fold(question)} `;
  return /^ (var|vart|where) /.test(q) || / var (ser|hittar|finns|star|kan) /.test(q);
}

/** The answer without a model: the best part, and more places on the same page lit up at once. */
export function composeAnswer(found: { doc: HelpDoc; score: number }[], question = ""): HelpAnswer {
  const [{ doc, score: top }] = found;
  const actions = docActions(doc).slice(0, 2);
  if (actions[0]) {
    const elements = found.filter((f) => f.doc.kind !== "guide");
    const best = doc.kind === "guide" ? top / GUIDE_BOOST : top;
    const extra = elements
      .filter((f) => f.doc !== doc && f.score >= best * RELATED && f.doc.route === actions[0].to && (f.doc.hash ?? "") === (actions[0].hash ?? ""))
      .flatMap((f) => f.doc.highlight ?? []);
    if (extra.length) actions[0] = { ...actions[0], highlight: [...new Set([...(actions[0].highlight ?? []), ...extra])] };
  }
  const text =
    doc.kind === "guide"
      ? (doc.answer ?? "")
      : doc.kind === "page"
        ? (doc.text || doc.title)
        : `${doc.title} ${UNDER} ${doc.where || FALLBACK_WHERE}.${doc.text ? ` ${doc.text}` : ""}`;
  return {
    known: true,
    text,
    steps: (doc.steps ?? []).slice(0, 8),
    actions,
    sources: [doc.id],
    ...(doc.live && !isWhereQuestion(question) ? { live: doc.live } : {}),
  };
}

export function refusal(): HelpAnswer {
  return { known: false, text: REFUSE_TEXT, steps: [], actions: [], sources: [] };
}

/** The console has no help page to send people to (TEXTS["console"]["help"] is None). */
export function unknownAnswer(): HelpAnswer {
  return { known: false, text: UNKNOWN_TEXT, steps: [], actions: [], sources: [] };
}

const FOLLOW_UP = /^ (och|men|samma|an|and|but|what about|how about) /;

/** Does the question alone find a document about what it names (its title or keywords)? */
function standsAlone(corpus: HelpCorpus, asked: string): boolean {
  const top = candidates(corpus, asked)[0]?.doc;
  if (!top) return false;
  const head = tokens([top.title, ...(top.keywords ?? [])].join(" "));
  return tokens(asked).some((q) => q !== "idag" && head.some((d) => matchWeight(q, d) > 0));
}

/** The answer without a model, with the previous question as support for follow-ups. */
export function answerLocally(corpus: HelpCorpus, question: string, previousQuestion = ""): HelpAnswer {
  if (isSecretQuestion(question)) return refusal();
  // A short follow-up ("And for last month?") is read together with the previous question;
  // a short question that stands on its own ("Where is MRR?") is not.
  const short = Boolean(previousQuestion) && tokens(question).length <= 2 &&
    (FOLLOW_UP.test(` ${fold(question)} `) || !standsAlone(corpus, question));
  let found = candidates(corpus, short ? `${previousQuestion} ${question}` : question);
  if (found.length === 0 && previousQuestion) found = candidates(corpus, short ? question : `${previousQuestion} ${question}`);
  return found.length ? composeAnswer(found, question) : unknownAnswer();
}
