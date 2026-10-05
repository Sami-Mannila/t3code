import { describe, it, expect } from "vite-plus/test";
import { fitOrganization, resizeOrganization, zoomOrganization } from "./organizationCamera";
describe("organization camera", () => {
  it("fits new scopes within the viewport", () => {
    const camera = fitOrganization({ width: 1000, height: 600 }, { width: 2000, height: 1000 });
    expect(camera.scale).toBe(0.48);
    expect(camera.x).toBe(20);
    expect(camera.y).toBe(60);
  });
  it("preserves user pan and zoom when a live graph grows without viewport changes", () => {
    const camera = { x: -400, y: 150, scale: 1.2 };
    const viewport = { width: 1000, height: 600 };
    expect(resizeOrganization(camera, viewport, viewport)).toEqual(camera);
  });
  it("preserves zoom and world center when the sidebar changes viewport size", () => {
    expect(
      resizeOrganization(
        { x: 20, y: 30, scale: 0.75 },
        { width: 1000, height: 600 },
        { width: 800, height: 500 },
      ),
    ).toEqual({ x: -80, y: -20, scale: 0.75 });
  });
});

it("keeps the pointer anchored to its world point during bounded canvas zoom", () => {
  const initial = { x: 30, y: 40, scale: 0.5 };
  const changed = zoomOrganization(initial, 250, 180, -100);
  expect((250 - changed.x) / changed.scale).toBeCloseTo((250 - initial.x) / initial.scale);
  expect((180 - changed.y) / changed.scale).toBeCloseTo((180 - initial.y) / initial.scale);
  expect(zoomOrganization(initial, 250, 180, -10000).scale).toBe(1.5);
});
