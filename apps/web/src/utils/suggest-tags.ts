/**
 * 建议标签：从正文里挑出「占比最高的几个词」，供用户点一下采纳。
 *
 * 三条边界（都是有意为之，不是偷懒）：
 *   1. **只算当前打开的这篇**，不落盘、不进索引。采纳与否是用户的动作，
 *      采纳之后才写 frontmatter 的 tags —— 侧栏标签云统计的是 tags，
 *      自动词如果直接进去会把它淹掉。
 *   2. **不改正文，也不新增防抖层**。随编辑器已有的「序列化 200ms + 保存 1200ms」时机算，
 *      不给自己开第二个定时器。
 *   3. **零依赖**：`Intl.Segmenter` 是浏览器原生的分词器（WebView2 与 Chromium 同一套 ICU），
 *      实测 5600 字符 22ms —— 毫秒级，不需要 worker、不需要预分词。
 */

/** 低于这个规模就不给建议：一句话的笔记里，词频没有任何含义，挑出来的必是噪音 */
const MIN_TOKENS = 30;

export const SUGGEST_LIMIT = 5;

/**
 * 停用词：只收**多字**的。单字词（的/了/在/是…）在 normalize 里就按长度滤掉了，
 * 列在这里是多余的。英文同理，只留真正高频的功能词。
 */
const STOPWORDS = new Set([
  // 中文功能词 / 高频虚词
  '因为', '所以', '但是', '如果', '那么', '这个', '那个', '这些', '那些', '一个', '一种', '一些',
  '我们', '你们', '他们', '它们', '自己', '什么', '怎么', '这样', '那样', '时候', '可以', '不能',
  '不要', '必须', '需要', '应该', '能够', '进行', '使用', '通过', '对于', '关于', '以及', '并且',
  '然后', '现在', '已经', '一直', '只是', '就是', '不是', '没有', '这里', '那里', '上面', '下面',
  '前面', '后面', '以后', '之前', '之后', '一样', '如何', '为什么', '每个', '各个', '等等', '而是',
  '或者', '同时', '而且', '虽然', '尽管', '由于', '因此', '于是', '另外', '此外', '例如', '比如',
  '一般', '通常', '还是', '只有', '还有', '而是', '并不', '不再', '这么', '多么', '多少', '两者',
  // 数量词：在中文里几乎总是修饰语，单独拎出来没有信息
  '一篇', '一条', '一次', '一句', '一段', '一行', '一项', '一份', '一下', '两个', '三个', '两种',
  // 英文功能词
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'not', 'but', 'have',
  'has', 'had', 'been', 'they', 'their', 'what', 'when', 'which', 'will', 'would', 'can', 'could',
  'should', 'there', 'here', 'then', 'than', 'into', 'out', 'about', 'over', 'such', 'only', 'also',
  'more', 'most', 'some', 'any', 'all', 'one', 'two', 'its', 'our', 'your', 'his', 'her', 'them',
  'these', 'those', 'is', 'an', 'as', 'at', 'be', 'by', 'do', 'does', 'did', 'if', 'in', 'it', 'no',
  'of', 'on', 'or', 'so', 'to', 'up', 'we', 'he', 'she', 'you',
]);

/**
 * 先把「不是内容的东西」拿掉，再分词。
 * 不这么做的话，代码块里的标识符、图片地址、`[[笔记名]]` 都会参与词频 —— 全是噪音。
 */
function stripNoise(markdown: string): string {
  return markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') // frontmatter
    .replace(/```[\s\S]*?```/g, ' ') // 围栏代码块
    .replace(/`[^`]*`/g, ' ') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[\[[^\]]*\]\]/g, ' ') // 笔记链接：是对别的页面的引用，不是这篇的内容
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 普通链接：留下文字
    .replace(/https?:\/\/\S+/g, ' ') // 裸地址
    .replace(/<[^>]+>/g, ' '); // HTML
}

/** 中日韩统一表意文字（含扩展 A、兼容区）—— 用来判「这个词要不要按字计长」 */
const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const IS_WORDISH = /^[\p{L}\p{N}]+$/u;

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null;

/** 归一化；返回 null 表示「不算一个词」 */
function normalize(raw: string): string | null {
  const text = raw.trim();
  if (!text || !IS_WORDISH.test(text)) return null; // 标点 / 纯符号
  if (/^\d+$/.test(text)) return null; // 纯数字
  const cjk = HAS_CJK.test(text);
  const word = cjk ? text : text.toLowerCase(); // 拉丁词统一小写，Notion/notion 合成一个
  const length = cjk ? [...word].length : word.length;
  if (length < 2) return null; // 单字 / 单字母
  if (STOPWORDS.has(word)) return null;
  return word;
}

/**
 * 返回 top N 关键词（按词频降序；同频保持**首次出现**的顺序，所以结果是稳定的）。
 * 正文太短（词数不足 MIN_TOKENS）时返回空数组 —— 宁可不给，也不给噪音。
 */
export function suggestTags(markdown: string, limit = SUGGEST_LIMIT): string[] {
  if (!segmenter) return [];
  const counts = new Map<string, number>();
  let total = 0;

  for (const part of segmenter.segment(stripNoise(markdown))) {
    if (!part.isWordLike) continue;
    const word = normalize(part.segment);
    if (!word) continue;
    total += 1;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  if (total < MIN_TOKENS) return [];
  // Map 的迭代顺序 = 插入顺序 = 首次出现顺序；Array.sort 稳定，同频不会被打乱
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}
