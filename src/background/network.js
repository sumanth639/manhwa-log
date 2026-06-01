// Registers background network header rules.
export async function setupNetworkRules() {
  if (typeof chrome === "undefined" || !chrome.declarativeNetRequest) return;
  try {
    const rules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "remove" }
          ]
        },
        condition: {
          urlFilter: "||api.asurascans.com",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ];

    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules
    });
    console.log("[ManhwaLog] Successfully registered DeclarativeNetRequest rules.");
  } catch (e) {
    console.error("[ManhwaLog] Failed to setup network rules:", e);
  }
}
