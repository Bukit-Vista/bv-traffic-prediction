import { expect, test } from "@playwright/test";

test("production dashboard defaults to Predicted Mobility and exposes all views", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Predicted mobility" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("mobility");
  const navigation = page.getByRole("navigation", { name: "Dashboard views" });
  await expect(navigation.getByRole("button").first()).toHaveText("Predicted mobility");
  await expect(page.getByRole("button", { name: "Route performance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Data health" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Predicted mobility" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Incidents" })).toHaveCount(0);
  await page.getByRole("button", { name: "Live traffic" }).click();
  await expect(page.getByRole("heading", { name: "Live traffic" })).toBeVisible();
  await expect(navigation.getByRole("button").first()).toHaveText("Live traffic");
  await expect(page.getByText("Weighted jam")).toBeVisible();
  await expect(page.getByText("Measured length")).toBeVisible();
  await expect(page.getByTestId("bali-mobility-map")).toBeVisible();
  await expect(page.getByTestId("bali-mobility-map")).toHaveAttribute("data-map-ready", "true");
  await expect(page.getByTestId("bali-mobility-map")).toHaveAttribute("data-heatmap-animation", "off");
  await expect(page.locator("[data-regency-label]")).toHaveCount(9);
  await expect(page.getByTestId("traffic-legend")).toContainText("Darker = heavier jam");
  await expect(page.getByTestId("traffic-legend")).toContainText("Congested");
  await expect(page.getByText("OpenStreetMap contributors")).toBeVisible();
});

test("general catchment OD includes DPS as a selectable focus", async ({ page }) => {
  await page.goto("/?view=mobility");
  const focus = page.getByLabel("Focus catchment");
  await expect(focus.locator('option[value="dps-airport-gateway"]')).toHaveCount(1);
  await focus.selectOption("dps-airport-gateway");

  const map = page.locator('[data-testid="bali-mobility-map"][data-od-flow-mode="general"]');
  await expect.poll(async () => Number(await map.getAttribute("data-od-flow-count"))).toBeGreaterThan(0);
  await expect(page.getByText(/directed pairs across 21 catchments/)).toBeVisible();
});

test("predicted mobility workspace reports real production readiness without fixtures", async ({ page, request }) => {
  const response = await request.get("/api/v1/mobility/readiness");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  await page.goto("/?view=mobility");
  await expect(page.getByRole("heading", { name: "Predicted mobility" })).toBeVisible();
  if (payload.data.ready) {
    await expect(page.getByTestId("predicted-mobility-workspace")).toBeVisible();
    await expect(page.getByText(/not an observed people|not represent observed people/i).first()).toBeVisible();
    const map = page.getByTestId("bali-mobility-map");
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(map).toHaveAttribute("data-map-rendered", "true");
    // The initial MapLibre moveend refreshes the viewport-backed prediction
    // collections. That refresh must update sources without hiding the canvas.
    await page.waitForTimeout(1_500);
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(map).toHaveAttribute("data-map-rendered", "true");
  } else {
    await expect(page.getByTestId("predicted-mobility-gate")).toBeVisible();
    await expect(page.getByText("Workspace open · production data blocked")).toBeVisible();
    await expect(page.getByText("The dashboard will not turn road congestion into people movement or substitute demo predictions.")).toBeVisible();
  }
});

test("jam heartbeat stays disabled when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?view=live");
  await expect(page.getByTestId("bali-mobility-map")).toHaveAttribute("data-map-ready", "true");
  await expect(page.getByTestId("bali-mobility-map")).toHaveAttribute("data-heatmap-animation", "off");
});

test("live traffic map stays mounted and reuses parsed tiles across dashboard navigation", async ({ page }) => {
  await page.goto("/?view=live");
  const map = page.getByTestId("bali-mobility-map");
  await expect(map).toHaveAttribute("data-map-rendered", "true");
  await map.evaluate((element) => element.setAttribute("data-instance-check", "preserved"));

  await page.getByRole("button", { name: "Route performance" }).click();
  await expect(map).toHaveAttribute("data-map-active", "false");
  await page.getByRole("button", { name: "Live traffic" }).click();

  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-map-active", "true");
  await expect(map).toHaveAttribute("data-instance-check", "preserved");
  await expect(map).toHaveAttribute("data-map-rendered", "true");
});

test("basemap has no application index when traffic overlays are disabled", async ({ page }) => {
  await page.goto("/?view=live");
  await expect(page.getByTestId("traffic-legend")).toBeVisible();
  await page.getByText("Jam heatmap pulse").click();
  await page.getByText("Road segments").click();
  await expect(page.getByTestId("traffic-legend")).toHaveCount(0);
  await expect(page.getByText("INDEX")).toHaveCount(0);
});

test("full-screen traffic explorer preserves the active map and exposes analysis controls", async ({ page }) => {
  await page.goto("/?view=live");
  const map = page.getByTestId("bali-mobility-map");
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-map-workspace", "embedded");

  await page.getByRole("button", { name: "Open map workspace" }).click();
  await expect(page.getByTestId("map-workspace")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bali traffic explorer" })).toBeVisible();
  await expect(map).toHaveAttribute("data-map-workspace", "expanded");
  await expect(page.getByLabel("Traffic explorer controls")).toContainText("Data layers");
  await expect(page.getByLabel("Traffic explorer controls")).toContainText("Data status");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("map-workspace")).toHaveCount(0);
  await expect(map).toHaveAttribute("data-map-workspace", "embedded");
});

test("pan and zoom reuse the province Flow snapshot without API reloads", async ({ page }) => {
  const flowRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/flow/map") flowRequests.push(request.url());
  });
  await page.goto("/?view=live");
  const map = page.getByTestId("bali-mobility-map");
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-flow-loading", /^(province-snapshot|redis-vector-tiles)$/);
  await expect(map).toHaveAttribute("data-traffic-fallback", /^(geojson|persistent-minzoom)$/);
  await expect(map).toHaveAttribute("data-flow-feature-count", /\d+/);
  await expect(map).toHaveAttribute("data-heatmap-lod", /^(province|vector-tiles)$/);
  await expect(map).toHaveAttribute("data-render-recoveries", "0");
  await expect(map).toHaveAttribute("data-heartbeat-fps", "0");
  const box = await map.boundingBox();
  expect(box).toBeTruthy();
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -700);
  await page.mouse.move(centerX + 80, centerY + 30);
  await page.mouse.down();
  await page.mouse.move(centerX - 80, centerY - 30, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(1200);
  expect(flowRequests).toHaveLength(0);
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(map).toHaveAttribute("data-flow-feature-count", /[1-9]\d*/);
  await expect(map).toHaveAttribute("data-heatmap-point-count", /[1-9]\d*/);
});

test("historical mode pins an exact slot and can return to latest", async ({ page }) => {
  await page.goto("/?view=live");
  const slot = page.getByRole("button", { name: /View historical slot/ }).first();
  await expect(slot).toBeVisible();
  await slot.click();
  await expect(page.getByText("Pinned historical slot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to latest" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("mode")).toBe("historical");
  await page.getByRole("button", { name: "Return to latest" }).click();
  await expect(page.getByText("Latest successful Flow slot")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe("latest");
});

test("route values and actual geometry come from the production APIs", async ({ page, request }) => {
  const response = await request.get("/api/v1/routes/latest");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  const route = payload.data.routes.find((candidate: { geometryAvailable: boolean; ratioVsTypical: number | null }) => candidate.geometryAvailable && candidate.ratioVsTypical != null);
  expect(route).toBeTruthy();

  await page.goto(`/?view=routes&route=${route.id}`);
  await expect(page.getByRole("heading", { name: "Route performance" })).toBeVisible();
  await expect(page.getByText(`${route.ratioVsTypical.toFixed(2)}×`).first()).toBeVisible();
  const routeMap = page.getByTestId("route-geometry-map");
  await expect(routeMap).toBeVisible();
  await expect(routeMap).toHaveAttribute("data-map-ready", "true");
  await expect(page.getByRole("status", { name: "Loading route map" })).toHaveCount(0);
  await expect(page.getByText("Actual path not yet available")).toHaveCount(0);
});

test("source health distinguishes run status and reports real coverage", async ({ page }) => {
  await page.goto("/?view=health");
  await expect(page.getByRole("heading", { name: "Data health" })).toBeVisible();
  await expect(page.getByText("Current collector state")).toBeVisible();
  await expect(page.getByText("Latest Flow coverage")).toBeVisible();
  await expect(page.getByText("Routes").first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "HTTP 429" })).toBeVisible();
});

test("route overview supports sorting and the bounded 12-hour history", async ({ page }) => {
  await page.goto("/?view=routes");
  const sort = page.getByLabel("Sort by");
  await expect(sort).toBeVisible();
  await sort.selectOption("ratio");
  await expect(page.getByRole("button", { name: "Latest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "12 hours" })).toBeVisible();
  await expect(page.getByText(/measurements/).first()).toBeVisible();
  await expect(page.getByText("Duration trends")).toBeVisible();
  await expect(page.getByText("Delay minutes and ratio")).toBeVisible();
});

test("source overview exposes exactly Flow and Route collector states", async ({ request }) => {
  const response = await request.get("/api/v1/traffic/overview");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.data.sources).toHaveLength(2);
  expect(payload.data.sources.map((source: { dataset: string }) => source.dataset).sort()).toEqual(["flow", "routes"]);
  expect(payload.meta.requestedAtUtc).toBeTruthy();
  expect(payload.meta.collectionSlotUtc).toBeTruthy();
});

test("12-hour source status reports the current completed UTC window", async ({ request }) => {
  const response = await request.get("/api/v1/traffic/window-status?hours=12");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.meta.windowHours).toBe(12);
  expect(new Date(payload.meta.windowEndExclusiveUtc).getUTCMinutes()).toBe(0);
  expect(payload.data.flow.expectedSlots).toBe(24);
  expect(payload.data.routes.expectedSlots).toBe(12);
  expect(payload.data.routes.expectedSamples).toBe(168);
  expect(payload.data.routes.expectedGeometries).toBe(168);
  expect(["complete", "partial"]).toContain(payload.meta.status);
});

test("unsupported modules return explicit unavailable metadata", async ({ request }) => {
  for (const path of ["/api/v1/incidents/map", "/api/v1/analytics/hotspots"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(503);
    const payload = await response.json();
    expect(payload.error.code).toBe("FEATURE_NOT_READY");
    expect(payload.meta.status).toBe("unavailable");
  }
  const readinessResponse = await request.get("/api/v1/mobility/readiness");
  const readiness = await readinessResponse.json();
  const mobilityResponse = await request.get("/api/v1/mobility/zones");
  if (readiness.data.ready) expect(mobilityResponse.ok()).toBeTruthy();
  else {
    expect(mobilityResponse.status()).toBe(503);
    expect((await mobilityResponse.json()).error.code).toBe("FEATURE_NOT_READY");
  }
});

test("Step 1 exposes mobility configuration and its current prediction gate", async ({ request }) => {
  const scopeResponse = await request.get("/api/v1/mobility/scope");
  expect(scopeResponse.ok()).toBeTruthy();
  const scope = await scopeResponse.json();
  expect(scope.data.scopeKey).toBe("dps-to-selected-centers");
  expect(typeof scope.data.predictionEnabled).toBe("boolean");
  expect(["draft", "approved"]).toContain(scope.data.status);

  const destinationResponse = await request.get("/api/v1/mobility/airport-destinations/config");
  expect(destinationResponse.ok()).toBeTruthy();
  const destinations = await destinationResponse.json();
  expect(destinations.data.destinations).toHaveLength(7);
  expect(destinations.data.scope.predictionEnabled).toBe(scope.data.predictionEnabled);

  const definitionsResponse = await request.get("/api/v1/routes");
  expect(definitionsResponse.ok()).toBeTruthy();
  const definitions = await definitionsResponse.json();
  expect(definitions.data.routes).toHaveLength(14);
  expect(definitions.data.routes.filter((route: { routeDirection: string }) => route.routeDirection === "from_airport")).toHaveLength(7);
  expect(definitions.data.routes.filter((route: { routeDirection: string }) => route.routeDirection === "to_airport")).toHaveLength(7);

  const slotsResponse = await request.get("/api/v1/routes/slots?hours=12");
  expect(slotsResponse.ok()).toBeTruthy();
  const slots = await slotsResponse.json();
  expect(slots.data.slots.length).toBeGreaterThan(0);
  expect(slots.data.slots.length).toBeLessThanOrEqual(12);
  expect(slots.meta.windowHours).toBe(12);
});

test("production Flow and Route APIs expose exact source identity and real geometry", async ({ request }) => {
  const slotsResponse = await request.get("/api/v1/flow/slots");
  expect(slotsResponse.ok()).toBeTruthy();
  const slots = await slotsResponse.json();
  expect(slots.data.slots.length).toBeLessThanOrEqual(24);
  expect(slots.meta.windowHours).toBe(12);
  const slot = slots.data.slots[0];
  expect(slot.sourceRunId).toBeTruthy();

  const flowResponse = await request.get(`/api/v1/flow/map?bbox=114.34,-8.90,115.78,-8.03&at=${encodeURIComponent(slot.slotUtc)}&limit=5000`);
  expect(flowResponse.ok()).toBeTruthy();
  const flow = await flowResponse.json();
  expect(flow.meta.slotUtc).toBe(slot.slotUtc);
  expect(flow.meta.semantics).toBe("measured_traffic");
  expect(flow.features.length).toBeGreaterThan(0);
  expect(flow.features[0].properties).toHaveProperty("collectionSlotUtc");
  expect(flow.features[0].properties).toHaveProperty("sourceUpdatedUtc");
  expect(flow.features[0].properties).toHaveProperty("fetchedAtUtc");

  const routesResponse = await request.get("/api/v1/routes/latest");
  expect(routesResponse.ok()).toBeTruthy();
  const routes = await routesResponse.json();
  expect(routes.meta.semantics).toBe("measured_route_condition");
  expect(routes.meta.disclaimer).toContain("do not represent observed people or trip counts");
  expect(routes.data.routes).toHaveLength(14);
  expect(routes.data.corridors).toHaveLength(7);
  expect(routes.data.corridors.every((corridor: { directions: { fromAirport: unknown; toAirport: unknown } }) => corridor.directions.fromAirport && corridor.directions.toAirport)).toBe(true);
  expect(routes.data.routes.filter((candidate: { routeDirection: string }) => candidate.routeDirection === "from_airport")).toHaveLength(7);
  expect(routes.data.routes.filter((candidate: { routeDirection: string }) => candidate.routeDirection === "to_airport")).toHaveLength(7);
  expect(routes.data.routes.every((candidate: { routePurpose: string }) => candidate.routePurpose === "airport_tourism")).toBe(true);
  const route = routes.data.routes.find((candidate: { geometryAvailable: boolean }) => candidate.geometryAvailable);
  expect(route.currentDurationSeconds).not.toBeNull();
  expect(route.typicalDurationSeconds).not.toBeNull();
  const geometryResponse = await request.get(`/api/v1/routes/${route.id}/geometry?at=latest`);
  expect(geometryResponse.ok()).toBeTruthy();
  const geometry = await geometryResponse.json();
  expect(geometry.meta.routePurpose).toBe("airport_tourism");
  expect(geometry.meta.routeGroupKey).toBe(route.routeGroupKey);
  expect(geometry.meta.routeDirection).toBe(route.routeDirection);
  expect(geometry.features.length).toBeGreaterThan(0);
  expect(geometry.features[0].properties.routeDirection).toBe(route.routeDirection);
  expect(geometry.features.map((feature: { properties: { sectionIndex: number } }) => feature.properties.sectionIndex)).toEqual(
    [...geometry.features].map((feature: { properties: { sectionIndex: number } }) => feature.properties.sectionIndex).sort((a: number, b: number) => a - b)
  );
});

test("unchanged dashboard resources return 304 while scoped changes return fresh data", async ({ request }) => {
  const version = await request.get("/api/v1/dashboard/version");
  expect(version.ok()).toBeTruthy();
  const versionEtag = version.headers().etag;
  expect(versionEtag).toBeTruthy();
  const unchangedVersion = await request.get("/api/v1/dashboard/version", { headers: { "If-None-Match": versionEtag } });
  expect(unchangedVersion.status()).toBe(304);
  expect(await unchangedVersion.body()).toHaveLength(0);

  const flowUrl = "/api/v1/flow/map?bbox=114.34,-8.90,115.78,-8.03&at=latest&minConfidence=0&limit=5000";
  const flow = await request.get(flowUrl);
  expect(flow.ok()).toBeTruthy();
  const flowEtag = flow.headers().etag;
  expect(flowEtag).toBeTruthy();
  expect((await request.get(flowUrl, { headers: { "If-None-Match": flowEtag } })).status()).toBe(304);

  const scopedFlow = await request.get("/api/v1/flow/map?bbox=114.40,-8.85,115.70,-8.10&at=latest&minConfidence=0&limit=5000", {
    headers: { "If-None-Match": flowEtag }
  });
  expect(scopedFlow.status()).toBe(200);
  expect(scopedFlow.headers().etag).not.toBe(flowEtag);

  const routes = await request.get("/api/v1/routes/latest?at=latest");
  expect(routes.ok()).toBeTruthy();
  const routeEtag = routes.headers().etag;
  expect(routeEtag).toBeTruthy();
  expect((await request.get("/api/v1/routes/latest?at=latest", { headers: { "If-None-Match": routeEtag } })).status()).toBe(304);
});

test("latest mode refreshes immediately when an idle page becomes active", async ({ page }) => {
  let versionRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/dashboard/version") versionRequests += 1;
  });
  await page.goto("/?view=live");
  await expect(page.getByText("Latest successful Flow slot")).toBeVisible();
  await page.waitForTimeout(1_100);
  const beforeResume = versionRequests;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => versionRequests, { timeout: 5_000 }).toBeGreaterThan(beforeResume);
});

test("traffic map remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Predicted mobility" })).toBeVisible();
  const map = page.getByTestId("bali-mobility-map");
  await map.scrollIntoViewIfNeeded();
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-map-rendered", "true");
});
