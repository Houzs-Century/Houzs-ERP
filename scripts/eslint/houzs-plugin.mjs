const DECISION_COMMENTS = [
  /^shortcut:\s*\S/,
  /(^|\n)@deprecated\b/,
  /\bHC-\d+\b|#\d{4,}\b|\bdocs\/(bugs|modules)\/|[一-鿿]/,
  /\bowner\b[^\n]{0,40}\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}[^\n]{0,40}\bowner\b/i,
  /\b(company-scope(-file)?|[a-z]+(-[a-z]+)*-ok):/,
];

const KEPT_COMMENTS = [
  ...DECISION_COMMENTS,
  /^eslint-enable\b/,
  /^(eslint|eslint-env|global|globals|exported)\s/,
  /^@ts-(expect-error|ignore|nocheck)\b[\s:-]*\S{3,}/,
  /^\/\s*<reference\s/,
  /^prettier-ignore\b/,
  /^[#@]__(PURE|NO_SIDE_EFFECTS)__$/,
  /^@vite-ignore\b/,
  /^webpack[A-Z]\w*\s*:/,
  /^(c8|istanbul|v8)\s+ignore\b/,
  /^(!|copyright\b|@license\b|@preserve\b|SPDX-License-Identifier:)/i,
  /^(?:https?:\/\/[^\s,]+|[A-Z]{2,}-\d+|#\d+)(?:[\s,]+(?:https?:\/\/[^\s,]+|[A-Z]{2,}-\d+|#\d+))*[\s,]*$/,
];

const TOOL_PRAGMA = /(^|\s)@(generated|vitest-project|ts-check|vitest-environment|jest-environment|jsx|jsxImportSource|jsxRuntime|jsxFrag|refresh)\b/;

const commentText = (comment) =>
  comment.type === 'Line'
    ? comment.value.trim()
    : comment.value
        .split('\n')
        .map((line) => line.replace(/^\s*\*?\s?/, ''))
        .join('\n')
        .trim();

function verdict(comment, sourceCode) {
  const text = commentText(comment);
  if (/^eslint-disable/.test(text)) return /\s--\s*\S/.test(text) ? 'kept' : 'directiveWithoutReason';
  if (KEPT_COMMENTS.some((re) => re.test(text)) || TOOL_PRAGMA.test(text)) return 'kept';
  if (/^@ts-(expect-error|ignore|nocheck)\b/.test(text)) return 'directiveWithoutReason';
  const isJsDoc = comment.type === 'Block' && comment.value.startsWith('*');
  if (isJsDoc && sourceCode.getTokenAfter(comment)?.value === 'export') return 'kept';
  return 'prose';
}

const isDirective = (text) => /^(eslint-|@ts-)/.test(text);

function verdicts(sourceCode) {
  const comments = sourceCode.getAllComments();
  const result = new Map(comments.map((c) => [c, verdict(c, sourceCode)]));
  const ownLine = (c) =>
    c.type === 'Line' &&
    !isDirective(commentText(c)) &&
    !sourceCode.lines[c.loc.start.line - 1].slice(0, c.loc.start.column).trim();
  let run = [];
  const flush = () => {
    if (run.some((c) => DECISION_COMMENTS.some((re) => re.test(commentText(c))))) {
      for (const c of run) result.set(c, 'kept');
    }
    run = [];
  };
  for (const c of comments) {
    if (!ownLine(c)) {
      flush();
      continue;
    }
    if (run.length && c.loc.start.line !== run.at(-1).loc.start.line + 1) flush();
    run.push(c);
  }
  flush();
  return result;
}

function removalRange(comment, sourceCode) {
  const { text } = sourceCode;
  let [start, end] = comment.range;
  const node = sourceCode.getNodeByRangeIndex(start);
  if (node?.type === 'JSXEmptyExpression' && node.parent.type === 'JSXExpressionContainer') {
    [start, end] = node.parent.range;
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline + 1;
  const ownLine = !text.slice(lineStart, start).trim() && !text.slice(end, lineEnd).trim();
  if (ownLine) return { range: [lineStart, lineEnd], text: '' };
  while (start > lineStart && /[ \t]/.test(text[start - 1])) start -= 1;
  const joinsWords = /\w/.test(text[start - 1] ?? '') && /\w/.test(text[end] ?? '');
  return { range: [start, end], text: joinsWords ? ' ' : '' };
}

const noProseComments = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    schema: [],
    messages: {
      prose:
        'Prose comment. Comments rot; say it in a name, a type, a test or a lint rule. ' +
        'Kept: `shortcut: <limit>, <when to upgrade>`, eslint directives with ` -- <reason>`, ' +
        '`@ts-expect-error <reason>`, JSDoc on an export, a bare URL or ticket id (HC-0257, #1234), ' +
        'tool pragmas, license headers.',
      directiveWithoutReason:
        'An eslint-disable needs its reason on the same line: `eslint-disable-next-line <rule> -- <reason>`.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        let group = null;
        const flush = () => {
          if (group) {
            const { comments, messageId } = group;
            context.report({
              loc: { start: group.start, end: group.end },
              messageId,
              fix: messageId === 'prose'
                ? (fixer) => comments.map((c) => {
                    const { range, text } = removalRange(c, sourceCode);
                    return fixer.replaceTextRange(range, text);
                  })
                : null,
            });
          }
          group = null;
        };
        const byComment = verdicts(sourceCode);
        for (const comment of sourceCode.getAllComments()) {
          const messageId = byComment.get(comment);
          const extendsGroup =
            group?.messageId === 'prose' &&
            messageId === 'prose' &&
            group.line &&
            comment.type === 'Line' &&
            comment.loc.start.line === group.end.line + 1;
          if (extendsGroup) {
            group.end = comment.loc.end;
            group.comments.push(comment);
            continue;
          }
          flush();
          if (messageId !== 'kept') {
            group = { start: comment.loc.start, end: comment.loc.end, messageId, line: comment.type === 'Line', comments: [comment] };
          }
        }
        flush();
      },
    };
  },
};

const TIMER_HOSTS = new Set(['window', 'globalThis', 'self']);

function timerName(call) {
  const { callee } = call;
  if (callee.type === 'Identifier') return callee.name;
  const hosted =
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    TIMER_HOSTS.has(callee.object.name);
  return hosted ? callee.property.name : null;
}

function isSleep(call, sourceCode) {
  const fn = sourceCode
    .getAncestors(call)
    .findLast((n) => n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');
  const resolveParam = fn?.params[0];
  return (
    fn?.parent.type === 'NewExpression' &&
    fn.parent.callee.type === 'Identifier' &&
    fn.parent.callee.name === 'Promise' &&
    resolveParam?.type === 'Identifier' &&
    call.arguments[0]?.type === 'Identifier' &&
    call.arguments[0].name === resolveParam.name
  );
}

const noImperativeTimers = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      setInterval:
        'setInterval is a hand-rolled poller. Poll with react-query `refetchInterval`, or a scheduled ' +
        'Worker cron on the backend. A timer that must stay is cleared in its useEffect cleanup.',
      setTimeout:
        'setTimeout usually papers over a race. Await the real promise or event instead. A real delay ' +
        '(debounce, toast hide) is cleared in its useEffect cleanup; tests use vi.useFakeTimers().',
      sleep:
        'A sleep guesses how long something takes. Await the promise that does the work, or poll with ' +
        '`refetchInterval`; tests use vi.useFakeTimers() and vi.advanceTimersByTime().',
    },
  },
  create(context) {
    return {
      CallExpression(call) {
        const name = timerName(call);
        if (name === 'setInterval') context.report({ node: call, messageId: 'setInterval' });
        if (name === 'setTimeout') {
          context.report({ node: call, messageId: isSleep(call, context.sourceCode) ? 'sleep' : 'setTimeout' });
        }
      },
    };
  },
};

export const houzsPlugin = {
  meta: { name: 'houzs' },
  rules: {
    'no-prose-comments': noProseComments,
    'no-imperative-timers': noImperativeTimers,
  },
};
