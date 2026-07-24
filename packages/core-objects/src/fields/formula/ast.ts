/**
 * Tagged-union AST produced by `parseFormula` (parser.ts) and consumed by
 * `evaluateFormula` (evaluator.ts). Pure data — no behaviour lives here.
 */

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export type FunctionName =
  | 'IF'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'ROUND'
  | 'ABS'
  | 'MIN'
  | 'MAX'
  | 'CONCAT'
  | 'UPPER'
  | 'LOWER'
  | 'LEN'
  | 'TODAY'
  | 'DAYS_BETWEEN';

export type AstNode =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'fieldRef'; key: string }
  | { kind: 'binary'; op: BinaryOp; left: AstNode; right: AstNode }
  | { kind: 'unary'; op: '-'; operand: AstNode }
  | { kind: 'call'; name: FunctionName; args: AstNode[] };
