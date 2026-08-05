export type FocusGuidance = {
  label: string;
  method: string;
  encouragement: string;
};

const GUIDANCE_RULES: Array<{
  label: string;
  keywords: RegExp;
  method: string;
}> = [
  {
    label: "阅读理解",
    keywords: /阅读|看书|教材|论文|文献|文章|章节/,
    method: "先确定这一段要回答的问题，再开始读；遇到分支先做标记，结束后再决定是否展开。",
  },
  {
    label: "回忆巩固",
    keywords: /复习|背诵|记忆|单词|回顾|默写/,
    method: "先不看材料回忆一遍，再对照补齐缺口；结束前用自己的话复述一次。",
  },
  {
    label: "解题练习",
    keywords: /习题|刷题|练习|计算|证明|真题|作业题/,
    method: "先写清已知条件和目标；卡住时记下具体卡点，再决定是否查看提示或资料。",
  },
  {
    label: "写作输出",
    keywords: /写作|论文|报告|作业|稿|提纲|文案/,
    method: "先写出这一段最想表达的一句话，再补证据和细节；暂时不要在措辞上反复打转。",
  },
  {
    label: "开发调试",
    keywords: /编程|代码|开发|调试|修复|测试|实现/,
    method: "先定义这段时间要验证的最小结果；一次只改变一个关键变量，并保留可复现步骤。",
  },
  {
    label: "整理推进",
    keywords: /整理|规划|计划|总结|复盘|归档|梳理/,
    method: "先把材料归入少数明确类别，再处理先后顺序；不要边归类边扩大范围。",
  },
];

const GENERAL_METHOD =
  "先明确这段结束时要留下什么；只保留当前需要的材料，其余想法先记下，结束后再处理。";

const ENCOURAGEMENTS = [
  "先把眼前这一段走完，剩下的等结束后再决定。",
  "不必一次解决全部，只需要把注意力放回当前动作。",
  "进度不需要表演，它会从这一段真实的投入里留下来。",
  "按自己的节奏完成这一段，结果留到结束后再判断。",
] as const;

function stableIndex(value: string, length: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % length;
}

export function getFocusGuidance(task: { id: string; title: string }): FocusGuidance {
  const rule = GUIDANCE_RULES.find((item) => item.keywords.test(task.title));
  return {
    label: rule?.label ?? "当下行动",
    method: rule?.method ?? GENERAL_METHOD,
    encouragement: ENCOURAGEMENTS[stableIndex(`${task.id}:${task.title}`, ENCOURAGEMENTS.length)],
  };
}
