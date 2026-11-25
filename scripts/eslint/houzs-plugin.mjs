const KEPT_COMMENTS = [
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
  /^((https?:\/\/\S+|[A-Z]{2,}-\d+|#\d+)[\s,]*)+$/,
  /^shortcut:\s*\S/,
];

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
  if (KEPT_COMMENTS.some((re) => re.test(text))) return 'kept';
  const isJsDoc = comment.type === 'Block' && comment.value.startsWith('*');
  if (isJsDoc && sourceCode.getTokenAfter(comment)?.value === 'export') return 'kept';
  return 'prose';
}

const noProseComments = {
  meta: {
    type: 'suggestion',
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
          if (group) context.report({ loc: { start: group.start, end: group.end }, messageId: group.messageId });
          group = null;
        };
        for (const comment of sourceCode.getAllComments()) {
          const messageId = verdict(comment, sourceCode);
          const extendsGroup =
            group?.messageId === 'prose' &&
            messageId === 'prose' &&
            group.line &&
            comment.type === 'Line' &&
            comment.loc.start.line === group.end.line + 1;
          if (extendsGroup) {
            group.end = comment.loc.end;
            continue;
          }
          flush();
          if (messageId !== 'kept') {
            group = { start: comment.loc.start, end: comment.loc.end, messageId, line: comment.type === 'Line' };
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
