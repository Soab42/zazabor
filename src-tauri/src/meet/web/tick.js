// A timer that isn't slowed down when the meeting window is hidden: the recording's canvas
// is drawn on its ticks.
'use strict';
let timer = 0;
onmessage = (e) => {
  clearInterval(timer);
  if (e.data > 0) timer = setInterval(() => postMessage(0), e.data);
};
