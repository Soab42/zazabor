import React, { useEffect, useState } from "react";

export default function Clock() {
  const [time, setTime] = useState(new Date());
  const tick = () => {
    setTime(new Date());
  };
  useEffect(() => {
    setInterval(tick, 1000);
  }, [time]);

  return <div>{time.toLocaleTimeString()}</div>;
}
