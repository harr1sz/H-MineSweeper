import type { SupportedLocale } from "../i18n";

export type AcademySpecialMessageId = keyof typeof ZH;
type Values = Readonly<Record<string, string | number>>;

const ZH = {
  "firstBoard.start": "先揭开棋盘中央的安全格，再根据数字继续。",
  "firstBoard.instructions": "完成整张 5×5 棋盘。左键揭开；右键或 F 插旗；点击已经揭开的数字可以快速展开其余相邻格。",
  "firstBoard.aria": "5 乘 5 无猜教学棋盘",
  "firstBoard.hidden": ({ row, column }: Values) => `第 ${row} 行第 ${column} 列，未揭开`,
  "firstBoard.flagged": ({ row, column }: Values) => `第 ${row} 行第 ${column} 列，已插旗`,
  "firstBoard.unavailable": "这个操作现在不能执行。先检查格子是否已揭开，以及数字旁的旗数是否满足。",
  "firstBoard.hitMine": "这里是雷。终局答案只用于说明这次失败；点击重试后，重新根据可见数字判断。",
  "firstBoard.keepGoing": "操作有效。继续根据新出现的数字寻找确定的安全格或雷。",
  "firstBoard.complete": "你完成了整张无猜棋盘。每一步都可以从当时可见的数字推出。",
  "firstBoard.retry": "重新开始这张棋盘",
  "chord.start": "先根据已揭开的数字找出尚未标记的雷。",
  "chord.instructions": "你可以直接揭开能确定安全的格；也可以给确定的雷插旗，再点击旗数已满足的数字，一次展开其余相邻格。",
  "chord.aria": "安全快速展开教学棋盘",
  "chord.unavailable": "这个数字旁的旗数还没有满足，暂时不能快速展开。",
  "chord.wrongFlagLoss": "刚才的旗插在安全格上。数字看似满足，但快速展开揭开了真正的雷。请重试，并先确认旗的位置有数字依据。",
  "chord.flagPlaced": "旗已放下。现在再核对：这面旗的位置是否能由旁边的数字确定？",
  "chord.keepGoing": "操作有效。继续处理剩余盖住格。",
  "chord.completeExpand": "你先确认了雷的位置，再点击已满足的数字安全展开了其余格子。",
  "chord.completeDirect": "你直接揭开了能确定安全的格，这同样正确；快速展开不是唯一允许的操作。",
  "chord.retry": "重试这个局面",
} as const;

const EN: { readonly [K in keyof typeof ZH]: string | ((values: Values) => string) } = {
  "firstBoard.start": "Reveal the protected center cell, then continue from the visible clues.",
  "firstBoard.instructions": "Finish the full 5 by 5 board. Left-click to reveal, right-click or press F to flag, and click a revealed clue to open its remaining neighbors when its flags are satisfied.",
  "firstBoard.aria": "5 by 5 no-guess teaching board",
  "firstBoard.hidden": ({ row, column }) => `Row ${row}, column ${column}, covered`,
  "firstBoard.flagged": ({ row, column }) => `Row ${row}, column ${column}, flagged`,
  "firstBoard.unavailable": "That action is not available yet. Check whether the cell is already open and whether the clue has the required number of flags.",
  "firstBoard.hitMine": "That cell was a mine. The final answer is shown only to explain this failed attempt; retry and use the visible clues.",
  "firstBoard.keepGoing": "The action worked. Use the newly visible clues to find another certain safe cell or mine.",
  "firstBoard.complete": "You finished the full no-guess board. Every move was derivable from the information visible at the time.",
  "firstBoard.retry": "Restart this board",
  "chord.start": "Use the revealed clues to find the remaining unflagged mine.",
  "chord.instructions": "You may reveal a cell that is certainly safe, or flag the certain mine and then click a clue whose flag count is satisfied to open its other neighbors at once.",
  "chord.aria": "Safe quick-open teaching board",
  "chord.unavailable": "That clue does not have the required number of adjacent flags yet, so it cannot open its neighbors.",
  "chord.wrongFlagLoss": "The flag was placed on a safe cell. The clue appeared satisfied, but quick-open revealed the real mine. Retry and confirm that every flag has clue-based support.",
  "chord.flagPlaced": "Flag placed. Check once more that the visible clues prove this exact cell is a mine.",
  "chord.keepGoing": "The action worked. Continue with the remaining covered cell.",
  "chord.completeExpand": "You confirmed the mine, then safely opened the other neighbors by clicking the satisfied clue.",
  "chord.completeDirect": "You directly revealed the certainly safe cell. That is also correct; quick-open is not the only allowed action.",
  "chord.retry": "Retry this position",
};

export function academySpecialMessage(locale: SupportedLocale, id: AcademySpecialMessageId, values: Values = {}): string {
  const message = (locale === "en-US" ? EN : ZH)[id];
  return typeof message === "function" ? message(values) : message;
}
