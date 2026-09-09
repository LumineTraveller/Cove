export interface AboutQuote {
  text: string;
  author: string;
}

/**
 * About-page quotations are kept locally so the page remains usable offline.
 * The wording is intentionally short enough for the quiet footer treatment;
 * authors and source wording were curated from the linked public quote pages.
 */
export const ABOUT_QUOTES: readonly AboutQuote[] = [
  { text: "己所不欲，勿施于人。", author: "孔子" },
  { text: "君子和而不同，小人同而不和。", author: "孔子" },
  { text: "岁寒，然后知松柏之后凋也。", author: "孔子" },
  { text: "敏于事而慎于言。", author: "孔子" },
  { text: "祸兮福所倚，福兮祸所伏。", author: "老子" },
  { text: "千里之行，始于足下。", author: "老子" },
  { text: "知人者智，自知者明。", author: "老子" },
  { text: "吾生也有涯，而知也无涯。", author: "庄子" },
  { text: "君子之交淡若水，小人之交甘若醴。", author: "庄子" },
  { text: "举世誉之而不加劝，举世非之而不加沮。", author: "庄子" },
  { text: "相视而笑，莫逆于心。", author: "庄子" },
  { text: "未经反思自省的人生没有意义。", author: "苏格拉底" },
  { text: "我只知道自己一无所知。", author: "苏格拉底" },
  { text: "一个人的价值，在于他贡献了什么，而不在于他能得到什么。", author: "爱因斯坦" },
  { text: "我不假装理解宇宙——它比我大多了。", author: "爱因斯坦" },
  { text: "所有理论都是灰色的，生命的金树常青。", author: "歌德" },
  { text: "感觉并不会诈欺，判断却会。", author: "歌德" },
  { text: "今天没开始做的事，明天绝不会完成。", author: "歌德" },
  { text: "能分享他人痛苦的，是人；能分享他人快乐的，是神。", author: "歌德" },
  { text: "人生的价值，并不是用时间，而是用深度去衡量的。", author: "托尔斯泰" },
  { text: "哪里有爱，哪里就有上帝。", author: "托尔斯泰" },
  { text: "真正的知识要靠思考而非记忆来习得。", author: "托尔斯泰" },
  { text: "凡事总须研究，才会明白。", author: "鲁迅" },
  { text: "即使慢，驰而不息，纵令落后，纵令失败，也一定可以达到目标。", author: "鲁迅" },
  { text: "没有可怕的深度，就没有美丽的水面。", author: "尼采" },
  { text: "谁终将声震人间，必长久深自缄默。", author: "尼采" },
  { text: "人生是一面镜子，我们终将从中辨认出自己。", author: "尼采" },
  { text: "凡具有生命者，都不断地在超越自己。", author: "尼采" },
  { text: "天空没有翅膀的痕迹，但我已飞过。", author: "泰戈尔" },
  { text: "听，是森林的声音，它隐身于花丛间，祈求着自由。", author: "泰戈尔" },
  { text: "热爱真理；原谅错误。", author: "伏尔泰" },
  { text: "我行了一点善，那是我最好的作品。", author: "伏尔泰" },
];

export function pickAboutQuote(previous?: AboutQuote | null): AboutQuote {
  if (ABOUT_QUOTES.length <= 1) return ABOUT_QUOTES[0];
  const candidates = previous
    ? ABOUT_QUOTES.filter((quote) => quote.text !== previous.text)
    : ABOUT_QUOTES;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? ABOUT_QUOTES[0];
}
