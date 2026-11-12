// Values shared by every material in the scene.

/** Uniforms shared by reference: updating one value updates every material. */
export const shared = {
  /** Seconds since the scene started. */
  uTime: { value: 0 },
  /** 1 while the Plan layer is shown. */
  uPlan: { value: 0 },
};

/** Colour behind the map, outside the area that was modelled. */
export const BACKDROP = "#22252b";
