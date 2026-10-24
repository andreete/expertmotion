// Stand-in for @remotion/player in jsdom tests: same ref API surface, renders a placeholder div.
import { forwardRef, useImperativeHandle, type CSSProperties } from 'react';

export const Player = forwardRef<unknown, { style?: CSSProperties }>((props, ref) => {
  useImperativeHandle(ref, () => ({
    play() {}, pause() {}, toggle() {}, seekTo() {}, getCurrentFrame: () => 0, requestFullscreen() {}, exitFullscreen() {}, isFullscreen: () => false,
    setVolume() {}, getVolume: () => 1, isMuted: () => false, isPlaying: () => false, mute() {}, unmute() {}, pauseAndReturnToPlayStart() {},
    getContainerNode: () => null, getScale: () => 1, addEventListener() {}, removeEventListener() {},
  }));
  return <div data-testid="remotion-player" style={props.style} />;
});
