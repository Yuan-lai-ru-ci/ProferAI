export const INTRO_FLUID_VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * .5 + .5;
  gl_Position = vec4(aPosition, 0., 1.);
}`

export const INTRO_FLUID_FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uOpacity;
uniform float uSeed;
uniform float uThemeLight;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.;
  float amp = .5;
  for (int i = 0; i < 4; i++) {
    value += noise(p) * amp;
    p = p * 2.02 + vec2(17.2, 9.3);
    amp *= .5;
  }
  return value;
}

float random(float index) {
  return fract(sin(index * 91.73 + uSeed * 17.41) * 43758.5453);
}

float splashValue(vec2 p, vec2 center, float start, float size, float phase, float age) {
  float aspect = uResolution.x / uResolution.y;
  vec2 c = vec2((center.x - .5) * aspect, center.y - .5);
  c += vec2(sin(age * .33 + phase), cos(age * .27 + phase)) * .018;
  vec2 q = p - c;
  q.x *= .72 + sin(phase) * .08;
  q = mat2(cos(phase), -sin(phase), sin(phase), cos(phase)) * q;
  float radius = .035 + age * (.062 + size * .018);
  float d = length(q);
  float ring = exp(-pow((d - radius) * (34. - age * 2.), 2.));
  float wake = exp(-d * 5.5) * (.5 + .5 * sin(d * 32. - age * 5. + phase));
  return (ring * .75 + wake * .18) * exp(-age * .19) * step(start, uTime);
}

// 时间方向运动模糊：对 splash 在 age 前后采样 3 次并加权平均，沿运动轨迹抹开，
// 减弱快速移动环/波纹产生的帧间明暗跳变（"闪屏"）。成本由像素化后的帧数/分辨率抵消。
float splash(vec2 p, vec2 center, float start, float size, float phase) {
  float age = max(0., uTime - start);
  if (age <= 0.) return 0.;
  float delta = .05;
  float w0 = .25, w1 = .5, w2 = .25;
  float s0 = splashValue(p, center, start, size, phase, age - delta);
  float s1 = splashValue(p, center, start, size, phase, age);
  float s2 = splashValue(p, center, start, size, phase, age + delta);
  return s0 * w0 + s1 * w1 + s2 * w2;
}

void main() {
  vec2 p = vec2((vUv.x - .5) * (uResolution.x / uResolution.y), vUv.y - .5);
  float t = uTime;
  float h = 0.;
  h += splash(p, vec2(.50 + (random(1.) - .5) * .24, .54 + (random(2.) - .5) * .18), .10, .90, random(3.) * 6.28) * .24;
  h += splash(p, vec2(.34 + (random(4.) - .5) * .18, .58 + (random(5.) - .5) * .16), .42, .76, random(6.) * 6.28) * .20;
  h += splash(p, vec2(.66 + (random(7.) - .5) * .22, .48 + (random(8.) - .5) * .20), .78, .82, random(9.) * 6.28) * .18;
  h += splash(p, vec2(.46 + (random(10.) - .5) * .26, .66 + (random(11.) - .5) * .14), 1.12, .70, random(12.) * 6.28) * .16;
  h += splash(p, vec2(.72 + (random(13.) - .5) * .16, .60 + (random(14.) - .5) * .18), 1.52, .64, random(15.) * 6.28) * .14;
  h += splash(p, vec2(.28 + (random(16.) - .5) * .16, .46 + (random(17.) - .5) * .18), 1.92, .58, random(18.) * 6.28) * .12;
  h += splash(p, vec2(.56 + (random(19.) - .5) * .22, .40 + (random(20.) - .5) * .16), 2.32, .52, random(21.) * 6.28) * .10;
  h += splash(p, vec2(.42 + (random(22.) - .5) * .20, .72 + (random(23.) - .5) * .12), 2.72, .48, random(24.) * 6.28) * .08;
  h = h / (1. + h * 1.2);
  vec2 warp = vec2(
    fbm(p * 3.2 + vec2(t * .08, -t * .05)),
    fbm(p * 3.2 + vec2(-t * .06, t * .07))
  ) - .5;
  float fragment = smoothstep(.54, .82, fbm(p * 7. + warp * 2. + t * .12));
  float caustic = smoothstep(.006, .22, h) * (.38 + fragment * .62);
  float mask = exp(-pow((p.x - .08) * .88, 4.) - pow((p.y - .11) * 2.15, 4.));
  float sheen = exp(-pow((p.y - .57) * 5.4, 2.)) * .004;
  float light = min((caustic * .40 + sheen) * mask * uOpacity, .20);
  light += min(pow(caustic, 2.) * .10 * fragment * mask * uOpacity, .06);
  vec3 darkColor = vec3(light * .72, light * .76, light * .84);
  // Canvas 是不透明的：浅色模式必须把底色写进 shader，不能依赖外层 CSS 背景。
  vec3 lightBase = vec3(.969, .969, .957);
  vec3 lightReflection = vec3(light * .58, light * .60, light * .66);
  vec3 lightColor = lightBase - lightReflection;
  vec3 color = mix(darkColor, lightColor, uThemeLight);
  gl_FragColor = vec4(color, 1.);
}`
