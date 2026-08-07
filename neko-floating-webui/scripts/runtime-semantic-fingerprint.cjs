const crypto = require('node:crypto');

function normalizeNodeText(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function getStableDeclarationName(ts, node, sourceFile) {
  if (node.name) return normalizeNodeText(node.name, sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name) {
    return `variable:${normalizeNodeText(parent.name, sourceFile)}`;
  }
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return `property:${normalizeNodeText(parent.name, sourceFile)}`;
  }
  if (ts.isBinaryExpression(parent) && parent.right === node) {
    return `assignment:${normalizeNodeText(parent.left, sourceFile)}`;
  }
  return '';
}

function getDeclarationName(ts, node, sourceFile) {
  const stableName = getStableDeclarationName(ts, node, sourceFile);
  if (stableName) return stableName;
  const parent = node.parent;
  if (ts.isCallExpression(parent)) {
    const argumentIndex = parent.arguments.indexOf(node);
    return `argument:${normalizeNodeText(parent.expression, sourceFile)}#${argumentIndex}`;
  }
  return '<anonymous>';
}

function isFingerprintScope(ts, node) {
  return ts.isFunctionLike(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node)
    || ts.isModuleDeclaration(node);
}

function isStableFingerprintScope(ts, node, sourceFile) {
  return isFingerprintScope(ts, node)
    && Boolean(getStableDeclarationName(ts, node, sourceFile));
}

const nodeTextSignatureCache = new WeakMap();
const stableScopeOrdinalCache = new WeakMap();
const directNestedScopesCache = new WeakMap();

function getEnclosingFingerprintScope(ts, node) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isFingerprintScope(ts, current)) return current;
    current = current.parent;
  }
  return current;
}

function getDirectNestedFingerprintScopes(ts, enclosingScope) {
  const cached = directNestedScopesCache.get(enclosingScope);
  if (cached) return cached;

  const scopes = [];
  function visit(node) {
    ts.forEachChild(node, (child) => {
      if (isFingerprintScope(ts, child)) {
        scopes.push(child);
        return;
      }
      visit(child);
    });
  }
  visit(enclosingScope);
  directNestedScopesCache.set(enclosingScope, scopes);
  return scopes;
}

function getStableScopeOrdinal(ts, node, sourceFile) {
  const cached = stableScopeOrdinalCache.get(node);
  if (cached !== undefined) return cached;

  const enclosingScope = getEnclosingFingerprintScope(ts, node) || sourceFile;
  const stableName = getStableDeclarationName(ts, node, sourceFile);
  let ordinal = 0;
  for (const candidate of getDirectNestedFingerprintScopes(ts, enclosingScope)) {
    if (candidate === node) break;
    if (
      candidate.kind === node.kind
      && getStableDeclarationName(ts, candidate, sourceFile) === stableName
    ) {
      ordinal += 1;
    }
  }
  stableScopeOrdinalCache.set(node, ordinal);
  return ordinal;
}

function getNodeTextSignature(node, sourceFile) {
  const cached = nodeTextSignatureCache.get(node);
  if (cached) return cached;
  const signature = crypto.createHash('sha256')
    .update(normalizeNodeText(node, sourceFile))
    .digest('hex');
  nodeTextSignatureCache.set(node, signature);
  return signature;
}

function getStructuralChildSegment(ts, parent, child, sourceFile) {
  for (const key of Object.keys(parent)) {
    if (key === 'parent') continue;
    const value = parent[key];
    if (value === child) return key;
    if (!Array.isArray(value)) continue;

    const childIndex = value.indexOf(child);
    if (childIndex === -1) continue;
    const childSignature = getNodeTextSignature(child, sourceFile);
    const sameSignatureOrdinal = value
      .slice(0, childIndex)
      .filter((sibling) => (
        sibling?.kind === child.kind
        && getNodeTextSignature(sibling, sourceFile) === childSignature
      ))
      .length;
    return `${key}:${ts.SyntaxKind[child.kind]}:${childSignature}#${sameSignatureOrdinal}`;
  }

  const siblings = [];
  ts.forEachChild(parent, (sibling) => siblings.push(sibling));
  const childIndex = siblings.indexOf(child);
  const childSignature = getNodeTextSignature(child, sourceFile);
  if (childIndex === -1) {
    return `${ts.SyntaxKind[child.kind]}:${childSignature}@${child.pos - parent.pos}`;
  }
  const sameSignatureOrdinal = siblings
    .slice(0, childIndex)
    .filter((sibling) => (
      sibling.kind === child.kind
      && getNodeTextSignature(sibling, sourceFile) === childSignature
    ))
    .length;
  return `${ts.SyntaxKind[child.kind]}:${childSignature}#${sameSignatureOrdinal}`;
}

function createDiagnosticEnclosingContext(ts, sourceFile, position) {
  const token = ts.getTokenAtPosition(sourceFile, position);
  const scopes = [];
  const syntaxPath = [];
  const structuralPath = [];
  let current = token;
  let reachedNearestScope = false;
  let reachedStableStructuralAnchor = false;

  while (current && !ts.isSourceFile(current)) {
    const isStableScope = isStableFingerprintScope(ts, current, sourceFile);
    if (!reachedStableStructuralAnchor && !isStableScope && current.parent) {
      structuralPath.push(
        getStructuralChildSegment(ts, current.parent, current, sourceFile)
      );
    }
    if (isFingerprintScope(ts, current)) {
      const declarationName = getDeclarationName(ts, current, sourceFile);
      const stableOrdinal = isStableScope
        ? `#${getStableScopeOrdinal(ts, current, sourceFile)}`
        : '';
      scopes.push(
        `${ts.SyntaxKind[current.kind]}:${declarationName}${stableOrdinal}`
      );
      reachedNearestScope = true;
    } else if (!reachedNearestScope) {
      syntaxPath.push(ts.SyntaxKind[current.kind]);
    }
    if (isStableScope) reachedStableStructuralAnchor = true;
    current = current.parent;
  }

  return {
    scopes: scopes.reverse(),
    syntaxPath: syntaxPath.reverse(),
    structuralPath: structuralPath.reverse()
  };
}

function createDiagnosticFingerprint({
  fileName,
  code,
  messageText,
  sourceLine,
  enclosingContext
}) {
  const identity = JSON.stringify([
    fileName,
    code,
    messageText,
    sourceLine,
    enclosingContext
  ]);
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function compareFingerprintMultisets(expected, actual) {
  const added = new Map();
  const removed = new Map();
  const fingerprints = new Set([...expected.keys(), ...actual.keys()]);

  for (const fingerprint of fingerprints) {
    const difference = (actual.get(fingerprint) || 0) - (expected.get(fingerprint) || 0);
    if (difference > 0) added.set(fingerprint, difference);
    if (difference < 0) removed.set(fingerprint, -difference);
  }

  return { added, removed };
}

module.exports = {
  createDiagnosticEnclosingContext,
  createDiagnosticFingerprint,
  compareFingerprintMultisets
};
