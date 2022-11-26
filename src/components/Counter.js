import React, { useEffect, useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    count < 0 ? setCount(0) : setCount(count);
  }, [count]);
  return (
    <div
      style={{
        display: "flex",
      }}
    >
      <button
        style={styles.btn}
        className={"select-none"}
        onMouseOver="this.style.backgroundColor='#F8F8F8'"
        onClick={() => setCount(count - 1)}
      >
        -
      </button>
      <p style={styles.p}>{count}</p>
      <button style={styles.btn} onClick={() => setCount(count + 1)}>
        +
      </button>
    </div>
  );
}

const styles = {
  btn: {
    all: "unset",
    backgroundColor: "rgba(125,212,122,1)",
    width: "1.5rem",
    height: "1.5rem",
    display: "block",
    cursor: "pointer",
    borderRadius: "1rem",
    textAlign: "center",
  },
  p: {
    all: "unset",
    width: "1.5rem",
    height: "1.5rem",
    marginTop: "0px",
    textAlign: "center",
    textShadow: "2px -1px 2px",
  },
};
