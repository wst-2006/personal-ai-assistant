const focusQuotes = [
  { text: "千里之行，始于足下。", source: "《道德经》" },
  { text: "不积跬步，无以至千里。", source: "《荀子·劝学》" },
  { text: "锲而不舍，金石可镂。", source: "《荀子·劝学》" },
  { text: "工欲善其事，必先利其器。", source: "《论语·卫灵公》" },
];

const breakQuotes = [
  { text: "一张一弛，文武之道也。", source: "《礼记·杂记下》" },
  { text: "流水不腐，户枢不蠹。", source: "《吕氏春秋·尽数》" },
  { text: "静以修身，俭以养德。", source: "诸葛亮《诫子书》" },
];

function stableIndex(seed: string, length: number) {
  let value = 0;
  for (let index = 0; index < seed.length; index += 1) {
    value = (value * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return value % length;
}

export function focusQuote(seed: string, resting: boolean) {
  const quotes = resting ? breakQuotes : focusQuotes;
  return quotes[stableIndex(`${seed}:${resting ? "break" : "focus"}`, quotes.length)];
}
