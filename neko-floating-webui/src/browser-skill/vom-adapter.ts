export const NEKO_OBSERVATION_IGNORE_ATTRIBUTE = "data-bsk-observation-ignore";

const DOM_SNAPSHOT_NEEDLE =
  "isOverlayHost = isOverlayHostNode(str(strings, dn.nodeName?.[n]), attrNames);";

const FALLBACK_NEEDLE = `    const found = await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: OVERLAY_HOST_SELECTOR,
    });
    if (typeof found.nodeId !== "number" || found.nodeId === 0) return excluded;

    const described = await cdp.send<{ node?: CdpDomNode }>(tabId, "DOM.describeNode", {
      nodeId: found.nodeId,
      depth: -1,
      pierce: true,
    });
    collectBackendIdsFromDomNode(described.node, excluded);`;

/**
 * Adapt the pinned BrowserSkill VOM capture without modifying the submodule.
 * Both the normal DOMSnapshot path and its older-Chromium fallback must skip
 * N.E.K.O's open Shadow DOM while retaining BrowserSkill's own overlay marker.
 */
export function adaptBrowserSkillVomCapture(source: string): string {
  const normalizedSource = source.replaceAll("\r\n", "\n");
  if (!normalizedSource.includes(DOM_SNAPSHOT_NEEDLE)) {
    throw new Error("BrowserSkill DOMSnapshot exclusion adapter no longer matches pinned source");
  }
  if (!normalizedSource.includes(FALLBACK_NEEDLE)) {
    throw new Error("BrowserSkill DOM fallback exclusion adapter no longer matches pinned source");
  }

  const adaptedSnapshot = normalizedSource.replace(
    DOM_SNAPSHOT_NEEDLE,
    `isOverlayHost =
        isOverlayHostNode(str(strings, dn.nodeName?.[n]), attrNames) ||
        attrNames.includes("${NEKO_OBSERVATION_IGNORE_ATTRIBUTE}");`,
  );

  return adaptedSnapshot.replace(
    FALLBACK_NEEDLE,
    `    const found = await cdp.send<{ nodeIds?: number[] }>(tabId, "DOM.querySelectorAll", {
      nodeId: rootNodeId,
      selector: OVERLAY_HOST_SELECTOR + ", [${NEKO_OBSERVATION_IGNORE_ATTRIBUTE}]",
    });
    for (const nodeId of found.nodeIds ?? []) {
      if (typeof nodeId !== "number" || nodeId === 0) continue;
      const described = await cdp.send<{ node?: CdpDomNode }>(tabId, "DOM.describeNode", {
        nodeId,
        depth: -1,
        pierce: true,
      });
      collectBackendIdsFromDomNode(described.node, excluded);
    }`,
  );
}
