import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export default function Card({ name, price, discount, image, index }) {
  const [count, setCount] = useState(1);
  useEffect(() => {
    count < 1 ? setCount(1) : setCount(count);
  }, [count]);
  return price ? (
    <div
      className={
        "items-center justify-center text-center w-64  rounded-lg p-1 pr-2 pl-2 overflow-hidden "
      }
    >
      <Link to={"product/" + index}>
        <div className="w-full h-32 overflow-hidden mb-1 duration-700 ">
          <img
            className=" object-fill h-32 w-80  hover:scale-125 hover:object-cover duration-500 "
            src={image}
            alt="card-img"
          />
        </div>
      </Link>
      <h4 className={"bg-red-300 text-sm p-1 m-1"}>{name}</h4>

      <price
        className={
          "flex justify-between pl-2 pr-2 backdrop:blur-sm m-1 bg-slate-500 p-1 rounded-xl text-white shadow-md shadow-gray-800 "
        }
      >
        <mainprice className="bg-black pl-2 pr-2">{price}$</mainprice>

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
        <pricediscount>{count * price}$</pricediscount>
      </price>
      <div className="text-white">
        discount price= {count * (price - (price * discount) / 100)}$
      </div>
      <button className="text-white bg-sky-600 w-full hover:bg-pink-300">
        Add to cart
      </button>
    </div>
  ) : null;
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
