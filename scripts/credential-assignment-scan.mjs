const assignmentPatterns = [
  {
    style: "computed",
    pattern: /\[\s*(["'`])([^"'`\r\n]+)\1\s*\]\s*(:=|[=:])(?![=>?+-])/gmu,
    nameGroup: 2,
  },
  {
    style: "quoted",
    pattern: /(["'])([^"'\r\n]+)\1\s*(:=|[=:])(?![=>?+-])/gmu,
    nameGroup: 2,
  },
  {
    style: "backtick-key",
    pattern: /`([^`\r\n]+)`\s*(:=|[=:])(?![=>?+-])/gmu,
    nameGroup: 1,
  },
  {
    style: "bare",
    pattern:
      /(?<![A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$.-]*)(?:[ \t]|\/\*[^*\r\n]*(?:\*(?!\/)[^*\r\n]*)*\*\/)*(:=|[=:])(?![=>?+-])/gmu,
    nameGroup: 1,
  },
];

const sensitiveSingleWords = new Set([
  "CREDENTIAL",
  "CREDENTIALS",
  "PASSWORD",
  "PASSWD",
  "SECRET",
  "TOKEN",
]);
const sensitiveKeyPrefixes = new Set([
  "API",
  "PRIVATE",
  "SECRET",
  "HASH",
  "ENCRYPTION",
  "SIGNING",
  "ACCESS",
]);
const typeWords = "(?:string|number|boolean|unknown|never|null|undefined|void)";
const policySuffixes = new Set([
  "AGE",
  "COUNT",
  "ENABLED",
  "EXPIRATION",
  "EXPIRY",
  "LENGTH",
  "LIMIT",
  "MATCH",
  "NAME",
  "PATTERNS",
  "STATUS",
  "TTL",
  "TYPE",
]);
function nameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase()
    .split("_")
    .filter(Boolean);
}

export function isCredentialAssignmentName(name, style = "bare") {
  const words = nameWords(name);
  if (!words.length) return false;
  if (name.toLowerCase() === "id-token") return false;
  if (policySuffixes.has(words.at(-1))) return false;

  return (
    words.some((word) => sensitiveSingleWords.has(word)) ||
    words.some((word, index) => word === "KEY" && sensitiveKeyPrefixes.has(words[index - 1])) ||
    (style !== "bare" && words.length === 1 && words[0] === "KEY")
  );
}

function isAssignmentNameSyntax(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/u.test(name);
}

function codeExcludedOffsets(text) {
  const excluded = new Uint8Array(text.length);
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1] ?? "";
    if (character === "/" && next !== "/" && next !== "*") {
      let previous = index - 1;
      while (previous >= 0 && /\s/u.test(text[previous])) previous -= 1;
      if (previous >= 0 && !/(?:[=(:,!{;?&|]|\[)/u.test(text[previous])) {
        index += 1;
        continue;
      }
      let end = index + 1;
      let escaped = false;
      let inCharacterClass = false;
      while (end < text.length) {
        const current = text[end];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "[") inCharacterClass = true;
        else if (current === "]") inCharacterClass = false;
        else if (current === "/" && !inCharacterClass) {
          end += 1;
          while (/[A-Za-z]/u.test(text[end] ?? "")) end += 1;
          break;
        } else if (current === "\n" || current === "\r") {
          break;
        }
        end += 1;
      }
      excluded.fill(1, index, end);
      index = end;
    } else {
      index += 1;
    }
  }
  return excluded;
}

function matchingClose(open) {
  return open === "(" ? ")" : open === "[" ? "]" : "}";
}

function continuesAcrossLine(text, valueStart, newlineIndex) {
  const before = text.slice(valueStart, newlineIndex).trimEnd();
  let afterIndex = newlineIndex;
  if (text[afterIndex] === "\r" && text[afterIndex + 1] === "\n") afterIndex += 2;
  else afterIndex += 1;
  const after = text.slice(afterIndex).trimStart();
  return (
    /(?:\?\?|\|\||&&|\+|\.|\\|\?|:)$/u.test(before) || /^(?:\?\?|\|\||&&|\+|\.|\?|:)/u.test(after)
  );
}

function readAssignmentValue(text, start, operator, context) {
  let index = start;
  const mayStartOnNextLine = operator.includes("=");
  while (
    index < text.length &&
    (/[\t ]/u.test(text[index]) || (mayStartOnNextLine && /[\r\n]/u.test(text[index])))
  ) {
    index += 1;
  }
  const valueStart = index;
  const stack = [];
  let quote = "";
  let escaped = false;

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1] ?? "";

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      } else if ((character === "\n" || character === "\r") && quote !== "`") {
        break;
      }
      index += 1;
      continue;
    }

    if (character === "`" && index > valueStart && !stack.length) {
      const beforeTemplate = text.slice(valueStart, index).trimEnd();
      if (!/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(beforeTemplate)) {
        break;
      }
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      index += 1;
      continue;
    }

    if (character === "(" || character === "[" || character === "{") {
      stack.push(matchingClose(character));
      index += 1;
      continue;
    }

    if (character === ")" || character === "]" || character === "}") {
      if (stack.at(-1) === character) {
        stack.pop();
        index += 1;
        if (
          context === "code" &&
          !stack.length &&
          text[valueStart] === "{" &&
          /^\s*(?:\/>|>)/u.test(text.slice(index))
        ) {
          break;
        }
        continue;
      }
      if (!stack.length) break;
    }

    if (!stack.length) {
      if (character === "\n" || character === "\r") {
        if (continuesAcrossLine(text, valueStart, index)) {
          index += character === "\r" && next === "\n" ? 2 : 1;
          continue;
        }
        break;
      }
      if (character === "," || character === ";") {
        break;
      }
      if (context !== "code" && character === "&" && next !== "&") break;
      if (character === "/" && next === "/" && /\s/u.test(text[index - 1] ?? " ")) break;
      if (character === "#" && /\s/u.test(text[index - 1] ?? " ")) break;
    }

    index += 1;
  }

  return text.slice(valueStart, index).trim();
}

function unwrapQuotedValue(value) {
  const candidate = value.trim();
  if (candidate.length < 2) return { quoted: false, value: candidate };
  const quote = candidate[0];
  if (!['"', "'", "`"].includes(quote) || candidate.at(-1) !== quote) {
    return { quoted: false, value: candidate };
  }
  return { quoted: true, value: candidate.slice(1, -1).trim() };
}

function isExplicitPlaceholderLiteral(value) {
  if (!value) return true;
  return (
    /^<[^<>\r\n]+>$/u.test(value) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\}$/u.test(value) ||
    /^\$\{\{\s*(?:secrets|vars|env|github|inputs)\.[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}$/u.test(value) ||
    /^(?:example|placeholder|replace[-_]?(?:me|with[-_][A-Za-z0-9_.-]+)|not[-_]?set|development[-_]?(?:only|[A-Za-z0-9_.-]+)|redacted|unset|\*{3,})$/iu.test(
      value,
    ) ||
    /^(?:test|fixture|synthetic)[-_][A-Za-z0-9_.-]*(?:placeholder|fixture)[A-Za-z0-9_.-]*$/iu.test(
      value,
    )
  );
}

const safeCodeStringLiterals = new Set(["include", "omit", "same-origin"]);

function isSafeEmbeddedCodeString(value) {
  if (!value || isExplicitPlaceholderLiteral(value) || safeCodeStringLiterals.has(value)) {
    return true;
  }
  if (/^[A-Z][A-Z0-9_]*$/u.test(value)) return true;
  if (/^(?:https?:\/\/|[a-z]+\/[a-z0-9.+-]+$)/iu.test(value)) return true;
  if (/\s/u.test(value)) return true;
  return value.length < 20 && !/^(?:live|prod|secret|token)[-_.]/iu.test(value);
}

function isSafeSyntheticTemplate(value) {
  if (!/^(?:test|fixture|synthetic)-/iu.test(value) || !/placeholder/iu.test(value)) {
    return false;
  }
  const expressions = [...value.matchAll(/\$\{([^{}]+)\}/gu)];
  if (!expressions.length) return false;
  const literal = value.replace(/\$\{[^{}]+\}/gu, "");
  return (
    /^[A-Za-z0-9_.-]+$/u.test(literal) &&
    expressions.every((match) => isSafeReferenceExpression(match[1].trim(), "code"))
  );
}

function isSafeCodeExpression(value) {
  if (value.includes("`")) return false;
  for (const match of value.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/gu)) {
    if (!isSafeEmbeddedCodeString(match[2])) return false;
  }
  if (/^[A-Za-z0-9._-]{20,}$/u.test(value)) return false;
  return /(?:\bawait\b|\bnew\b|[(){}.?:]|\[|\]|===?|!==?|>=?|<=?|&&|\|\|)/u.test(value);
}

function isSafeSingleIdentifier(value, context) {
  if (/^(?:null|undefined|false|true|NULL|required|configured)$/u.test(value)) return true;
  if (/^[0-9]+$/u.test(value)) return true;
  if (new RegExp(`^${typeWords}$`, "u").test(value)) return true;
  if (context === "code" && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)) return true;
  return (
    /^[A-Z][A-Z0-9_]*(?:_FROM_[A-Z0-9_]+|_(?:REF|REFERENCE))$/u.test(value) ||
    /^(?:process\.env|import\.meta\.env|env|secrets|vars|config|values|bindings)(?:(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)|\[(?:[A-Za-z_$][A-Za-z0-9_$]*|"[A-Za-z0-9_.-]+"|'[A-Za-z0-9_.-]+')\])+$/u.test(
      value,
    )
  );
}

function isSafeInterpolatedValue(value, context) {
  const expressions = [...value.matchAll(/\$\{([^{}]+)\}/gu)];
  if (!expressions.length) return false;
  if (!expressions.every((match) => isSafeReferenceExpression(match[1].trim(), context))) {
    return false;
  }
  const literal = value.replace(/\$\{[^{}]+\}/gu, "");
  return !/(?:live|prod|secret|token)[-_.]/iu.test(literal) && !/[A-Za-z0-9_-]{20,}/u.test(literal);
}

function isSafeReferenceExpression(value, context) {
  if (
    /^\?[0-9]*$/u.test(value) ||
    /^\$[1-9][0-9]*$/u.test(value) ||
    /^:[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
  ) {
    return true;
  }
  if (isSafeSingleIdentifier(value, context)) return true;
  if (new RegExp(`^${typeWords}(?:\\s*\\|\\s*${typeWords})+$`, "u").test(value)) return true;
  if (
    context === "code" &&
    /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\|\s*(?:null|undefined)$/u.test(value)
  ) {
    return true;
  }

  const firstIdentifier = value.match(/^(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/u)?.[1];
  if (
    context !== "code" &&
    firstIdentifier &&
    !["process", "import", "env", "secrets", "vars", "config", "values", "bindings"].includes(
      firstIdentifier,
    ) &&
    !value.includes("(")
  ) {
    return false;
  }

  let index = 0;
  let sawStructure = false;
  const stack = [];
  while (index < value.length) {
    const rest = value.slice(index);
    const whitespace = rest.match(/^\s+/u);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }

    const string = rest.match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/u);
    if (string) {
      const inner = string[0].slice(1, -1);
      if (
        inner &&
        !isExplicitPlaceholderLiteral(inner) &&
        !isCredentialAssignmentName(inner, "quoted") &&
        !/^(?:string|number|boolean|object|undefined|cf-turnstile-response)$/u.test(inner)
      ) {
        return false;
      }
      sawStructure = true;
      index += string[0].length;
      continue;
    }

    const multiCharacterOperator = rest.match(/^(?:===|!==|==|!=|\?\?|\|\||&&|\?\.)/u);
    if (multiCharacterOperator) {
      sawStructure = true;
      index += multiCharacterOperator[0].length;
      continue;
    }

    const character = value[index];
    if (character === "(" || character === "[") {
      stack.push(matchingClose(character));
      sawStructure = true;
      index += 1;
      continue;
    }
    if (character === ")" || character === "]") {
      if (stack.pop() !== character) return false;
      index += 1;
      continue;
    }
    if (
      character === "." ||
      character === "," ||
      character === "!" ||
      character === "?" ||
      character === ":"
    ) {
      sawStructure = true;
      index += 1;
      continue;
    }

    const identifier = rest.match(/^(?:await\b|this\b|[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+)\b/u);
    if (identifier) {
      index += identifier[0].length;
      continue;
    }
    return false;
  }

  return sawStructure && stack.length === 0;
}

export function isExplicitCredentialPlaceholder(value, options = {}) {
  const context = options.context ?? "metadata";
  const trimmed = value.trim();
  const quote = trimmed[0] ?? "";
  const { quoted, value: candidate } = unwrapQuotedValue(trimmed);
  if (!candidate) return true;
  if (isExplicitPlaceholderLiteral(candidate)) return true;
  if (quoted && quote === "`" && context === "code" && isSafeSyntheticTemplate(candidate)) {
    return true;
  }
  if (quoted && context === "code" && safeCodeStringLiterals.has(candidate)) return true;
  if (quoted) return false;
  if (context === "code") {
    const jsxExpression = candidate.match(/^\{([^{}]+)\}$/u);
    if (jsxExpression && isSafeReferenceExpression(jsxExpression[1].trim(), context)) return true;
  }
  const interpolation = candidate.match(/^\$\{([\s\S]+)\}$/u);
  if (interpolation && isSafeReferenceExpression(interpolation[1].trim(), context)) return true;
  if (isSafeInterpolatedValue(candidate, context)) return true;
  if (context === "code" && isSafeCodeExpression(candidate)) return true;
  return isSafeReferenceExpression(candidate, context);
}

export function findCredentialAssignments(text, options = {}) {
  if (typeof text !== "string" || !text) return [];
  const matches = [];
  const context = options.context ?? "metadata";
  const excludedOffsets = context === "code" ? codeExcludedOffsets(text) : null;

  for (const { style, pattern, nameGroup } of assignmentPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[nameGroup];
      if (excludedOffsets?.[match.index]) continue;
      if (style !== "bare" && !isAssignmentNameSyntax(name)) continue;
      if (!isCredentialAssignmentName(name, style)) continue;
      const operator = match.at(-1);
      const delimiterOffset = match.index + match[0].lastIndexOf(operator);
      let value = readAssignmentValue(text, delimiterOffset + operator.length, operator, context);
      if (
        context === "documentation" &&
        style === "bare" &&
        operator === ":" &&
        nameWords(name).length === 1
      ) {
        continue;
      }
      if (style === "backtick-key" && operator === ":" && !/^(?:["'`]|\$\{|[^\s]+$)/u.test(value)) {
        continue;
      }
      if (operator === ":" && context === "code") {
        const typedAssignment = value.match(
          new RegExp(`^${typeWords}(?:\\s*\\|\\s*${typeWords})*\\s*=\\s*([\\s\\S]+)$`, "u"),
        );
        if (typedAssignment) value = typedAssignment[1].trim();
      }
      matches.push({
        index: match.index,
        line: text.slice(0, match.index).split("\n").length,
        name,
        style,
        value,
      });
    }
  }

  matches.sort((left, right) => left.index - right.index || left.style.localeCompare(right.style));
  return matches.filter(
    (match, index) =>
      !matches.some(
        (other, otherIndex) =>
          otherIndex < index && other.index === match.index && other.name === match.name,
      ),
  );
}

export function findUnsafeCredentialAssignments(text, options = {}) {
  return findCredentialAssignments(text, options).filter(
    (assignment) => !isExplicitCredentialPlaceholder(assignment.value, options),
  );
}
