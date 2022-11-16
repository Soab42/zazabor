import React from "react";

export default function Card() {
  return (
    <div style={styles.card}>
      <div style={styles.imge}>
        <img src="logo192.png" alt="card-img" />
      </div>
      <h4 style={styles.h}>React</h4>
      <p>Beginer Course</p>

      <price style={styles.price}>
        <mainprice
          style={{ backgroundColor: "black", color: "white", width: "40%" }}
        >
          10$
        </mainprice>
        <pricediscount
          style={{ backgroundColor: "rgb(0,240,255)", width: "40%" }}
        >
          8$
        </pricediscount>
      </price>
    </div>
  );
}
const styles = {
  price: {
    display: "flex",
    justifyContent: "space-around",
    width: "80%",
    borderRadius: "3rem",
    boxShadow: "0px 0px 4px 0px rgba(0, 0, 0, .5)",
  },
  card: {
    backgroundColor: "rgba(255,200,202,1)",
    width: "15rem",
    height: "20rem",
    display: "flex",
    flexDirection: "column",
    cursor: "pointer",
    textAlign: "center",
    overflow: "hidden",
    justifyContent: "start",
    backdropFilter: "blur(10px)",
    alignItems: "center",
    borderRadius: "1rem",
    boxShadow: "1px px 4px 2px rgba(0, 0, 0, .2)",
  },

  imge: {
    backgroundColor: "pink",
    height: "12rem",
    borderRadius: "1rem",
    width: "15rem",
    boxShadow: "2px 2px 2px rgba(255, 0, 0, .2)",
  },
  h: {
    margin: "0",
    padding: ".5rem",
    boxShadow: "0px 0px 1px 0px rgba(0, 0, 0, .5)",
    width: "14rem",
    marginTop: ".2rem",
    backgroundColor: "transparent",
    borderRadius: ".5rem",
  },
};
