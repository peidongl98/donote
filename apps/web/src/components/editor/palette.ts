/**
 * 思维导图的配色 —— 渲染出来的图（mermaid）和可视化编辑器（MindmapEditor）共用这一份。
 *
 * 为什么需要自己配色：mermaid 的 neutral / dark 主题对 mindmap 只会**深浅交替**上色
 * （第 1 个分支浅灰、第 2 个分支深灰、第 3 个又浅），既没有层级区分，根节点还和一级分支
 * 同色 —— 一眼看不出中心在哪，浅灰底上的字也发虚。
 *
 * 这里的规则只有两条：
 * 1. **每个一级分支一个色相**，自己这一支的子孙沿用同一个色相；
 * 2. **深度决定明度**：根最深（白字）、一级中深、二级浅、三级以后更浅。
 *    深浅差在 30% 以上，缩到 40% 看也分得开。
 *
 * 暗色主题不是把浅色反过来，而是重新取一套：底色压暗、文字提亮，
 * 否则浅色主题的「浅底深字」在暗背景上会变成一块块发光的白斑。
 */

export interface MindTone {
  /** 节点底色 */
  fill: string;
  /** 节点文字 */
  text: string;
  /** 节点描边 */
  border: string;
  /** 连线 */
  line: string;
}

/** 六个色相：蓝（与主色同族）、青、紫、琥珀、玫红、绿 */
const HUES = [212, 170, 268, 32, 344, 118];

function hueOf(branch: number): number {
  const at = ((branch % HUES.length) + HUES.length) % HUES.length;
  return HUES[at];
}

/**
 * `depth` 从 0 起（0 = 中心），`branch` 是一级分支的序号（中心传 -1 或被忽略）。
 */
export function mindTone(depth: number, branch: number, dark: boolean): MindTone {
  const h = hueOf(branch);

  if (depth <= 0) {
    return dark
      ? {
          fill: 'hsl(214 62% 62%)',
          text: '#0a1020',
          border: 'hsl(214 62% 74%)',
          line: 'hsl(214 40% 56%)',
        }
      : {
          fill: 'hsl(214 32% 27%)',
          text: '#ffffff',
          border: 'hsl(214 32% 20%)',
          line: 'hsl(214 24% 46%)',
        };
  }

  if (depth === 1) {
    return dark
      ? {
          fill: `hsl(${h} 42% 34%)`,
          text: `hsl(${h} 70% 94%)`,
          border: `hsl(${h} 46% 48%)`,
          line: `hsl(${h} 40% 50%)`,
        }
      : {
          fill: `hsl(${h} 46% 43%)`,
          text: '#ffffff',
          border: `hsl(${h} 44% 35%)`,
          line: `hsl(${h} 42% 62%)`,
        };
  }

  if (depth === 2) {
    return dark
      ? {
          fill: `hsl(${h} 32% 24%)`,
          text: `hsl(${h} 55% 88%)`,
          border: `hsl(${h} 30% 40%)`,
          line: `hsl(${h} 32% 44%)`,
        }
      : {
          fill: `hsl(${h} 58% 90%)`,
          text: `hsl(${h} 48% 24%)`,
          border: `hsl(${h} 42% 76%)`,
          line: `hsl(${h} 40% 74%)`,
        };
  }

  return dark
    ? {
        fill: `hsl(${h} 22% 18%)`,
        text: `hsl(${h} 40% 80%)`,
        border: `hsl(${h} 24% 32%)`,
        line: `hsl(${h} 24% 36%)`,
      }
    : {
        fill: `hsl(${h} 44% 96%)`,
        text: `hsl(${h} 34% 30%)`,
        border: `hsl(${h} 36% 86%)`,
        line: `hsl(${h} 34% 84%)`,
      };
}
