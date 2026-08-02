import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

const DIRECT_TEXT_ALLOWLIST = new Set([
  "H",
  "P",
  "3BV",
  "3BV/s",
  "IOE",
  "CPS / Cl/s",
  "H-MineSweeper",
  "5–100 / ≤10K",
]);
const VISIBLE_STRING_ATTRIBUTES = new Set(["alt", "aria-label", "placeholder", "title"]);

function uiFiles(directory = SOURCE_ROOT): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return uiFiles(path);
    if (
      !entry.name.endsWith(".tsx") ||
      entry.name.endsWith(".test.tsx") ||
      entry.name === "i18n.tsx" ||
      entry.name === "main.tsx"
    ) {
      return [];
    }
    return [path];
  });
}

function hasVisibleCopy(value: string): boolean {
  return /[A-Za-z\u3400-\u9fff]/u.test(value) && !DIRECT_TEXT_ALLOWLIST.has(value.trim());
}

function renderedStringLiterals(expression: ts.Expression): readonly string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return renderedStringLiterals(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return [
      ...renderedStringLiterals(expression.whenTrue),
      ...renderedStringLiterals(expression.whenFalse),
    ];
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [
      ...renderedStringLiterals(expression.left),
      ...renderedStringLiterals(expression.right),
    ];
  }
  if (ts.isTemplateExpression(expression)) {
    return [expression.head.text, ...expression.templateSpans.map(({ literal }) => literal.text)];
  }
  return [];
}

describe("localized UI source", () => {
  it("keeps direct JSX copy and visible string attributes in the message catalog", () => {
    const violations: string[] = [];
    for (const sourcePath of uiFiles()) {
      const relativePath = relative(SOURCE_ROOT, sourcePath);
      const source = readFileSync(sourcePath, "utf8");
      const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const inspect = (node: ts.Node): void => {
        if (ts.isJsxText(node)) {
          const text = node.text.trim();
          if (text && hasVisibleCopy(text)) {
            violations.push(`${relativePath}: direct text ${JSON.stringify(text)}`);
          }
        } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
          for (const text of renderedStringLiterals(node.expression)) {
            if (hasVisibleCopy(text)) {
              violations.push(`${relativePath}: rendered string ${JSON.stringify(text.trim())}`);
            }
          }
        } else if (
          ts.isJsxAttribute(node) &&
          VISIBLE_STRING_ATTRIBUTES.has(node.name.getText(sourceFile)) &&
          node.initializer
        ) {
          if (ts.isStringLiteral(node.initializer) && hasVisibleCopy(node.initializer.text)) {
            violations.push(`${relativePath}: visible attribute ${JSON.stringify(node.initializer.text)}`);
          } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
            for (const text of renderedStringLiterals(node.initializer.expression)) {
              if (hasVisibleCopy(text)) {
                violations.push(`${relativePath}: visible attribute ${JSON.stringify(text.trim())}`);
              }
            }
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
    }
    expect(violations).toEqual([]);
  });

  it("keeps the no-JavaScript document metadata aligned with the Chinese default", () => {
    const html = readFileSync(join(SOURCE_ROOT, "..", "index.html"), "utf8");
    expect(html).toContain("本地单人扫雷训练、可验证复盘与引导练习。");
    expect(html).toContain("H‑MineSweeper · 专业单人训练 Alpha");
    expect(html).not.toMatch(/Build a memory|Professional Solo|deterministic review/iu);
  });
});
