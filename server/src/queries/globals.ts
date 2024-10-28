import { parserQuery } from './utils/parserQuery';
import * as Parser from 'web-tree-sitter';
import { asLspRange } from '../utils/position';

const query = parserQuery`
(function_definition name: (function_name) @function)
(global_var_declaration name: (identifier) @globalVar)
(constant_declaration name: (identifier) @const)
`

export function queryGlobals(node: Parser.SyntaxNode) {
  return query().captures(node).map(a => ({
    text: a.node.text,
    type: a.name,
    range: asLspRange(a.node),
    node: a.node
  }));
}
