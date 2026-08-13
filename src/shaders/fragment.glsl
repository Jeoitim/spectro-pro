precision highp float;

uniform sampler2D uSpectrogramSampler;
uniform sampler2D uScaleSampler;
uniform sampler2D uGradientSampler;
uniform float uSpectrogramOffset;
uniform float uSpectrogramLength;
uniform float uSpectrogramDataStart;
uniform float uSpectrogramDataEnd;
uniform vec2 uScaleRange;
uniform float uContrast;
uniform float uSensitivity;
uniform float uZoom;
uniform float uTimeOffset;
varying vec2 vVertexTexCoord;

void main() {
    float sampleX = texture2D(
        uScaleSampler,
        vec2(
            0.0,
            uScaleRange.y - uScaleRange.y * vVertexTexCoord.y + uScaleRange.x * vVertexTexCoord.y
        )
    ).r;

    float globalSampleY = clamp(
        (vVertexTexCoord.x - 1.0) / uZoom + uSpectrogramLength - uTimeOffset,
        0.0,
        1.0
    );
    float sampleY = mod(
        (globalSampleY - uSpectrogramDataStart) /
            max(0.000001, uSpectrogramDataEnd - uSpectrogramDataStart) *
            uSpectrogramLength +
            uSpectrogramOffset,
        1.0
    );

    float intensity = clamp(
        texture2D(uSpectrogramSampler, vec2(sampleX, sampleY)).r * uSensitivity,
        0.0,
        1.0
    );
    if (uContrast > 0.0) {
        intensity = log(1.0 + intensity * uContrast) / log(1.0 + uContrast);
    }

    // Prevent wrapping issues when the spectrogram is smaller than the screen
    if (
        globalSampleY < uSpectrogramDataStart || globalSampleY > uSpectrogramDataEnd
    ) {
        intensity = 0.0;
    }

    vec3 color = texture2D(uGradientSampler, vec2(0.0, intensity)).rgb;
    gl_FragColor = vec4(color.r, color.g, color.b, 1.0);
}
