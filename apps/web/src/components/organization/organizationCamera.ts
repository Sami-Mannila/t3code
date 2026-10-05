export interface OrganizationCamera {
  x: number;
  y: number;
  scale: number;
}
export interface Size {
  width: number;
  height: number;
}
export function fitOrganization(viewport: Size, graph: Size): OrganizationCamera {
  const scale = Math.max(
    0.01,
    Math.min(1, (viewport.width - 40) / graph.width, (viewport.height - 40) / graph.height),
  );
  return {
    x: (viewport.width - graph.width * scale) / 2,
    y: (viewport.height - graph.height * scale) / 2,
    scale,
  };
}
/** A live graph update is not a camera command. Only viewport resizing shifts its center. */
export function resizeOrganization(
  camera: OrganizationCamera,
  before: Size,
  after: Size,
): OrganizationCamera {
  return {
    ...camera,
    x: camera.x + (after.width - before.width) / 2,
    y: camera.y + (after.height - before.height) / 2,
  };
}
export function zoomOrganization(
  camera: OrganizationCamera,
  x: number,
  y: number,
  delta: number,
): OrganizationCamera {
  const scale = Math.max(0.15, Math.min(1.5, camera.scale * Math.exp(-delta * 0.005)));
  return {
    scale,
    x: x - ((x - camera.x) * scale) / camera.scale,
    y: y - ((y - camera.y) * scale) / camera.scale,
  };
}
