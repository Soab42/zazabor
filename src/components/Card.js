import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export default function Card({ name, price, discount, image, index }) {
  const [count, setCount] = useState(1);
  useEffect(() => {
    count < 1 ? setCount(1) : setCount(count);
  }, [count]);
  return price ? (
    <Link to={"product/" + index}>
      <div
        className={
          "items-center justify-center text-center w-full  rounded-lg p-1  overflow-hidden bg-red-200"
        }
      >
        <div className="w-full h-44 overflow-hidden mb-1 duration-700">
          <img
            className=" object-fill h-full w-full  hover:scale-125 hover:object-cover duration-500 "
            src={image}
            alt="card-img"
          />
        </div>
        <div className={""}>{name}</div>
        <price
          className={
            "flex justify-between text-black shadow-sm shadow-pink-800 "
          }
        >
          <mainprice className="pl-2 pr-2">{price}$</mainprice>

          <pricediscount>
            {count * (price - (price * discount) / 100)}$
          </pricediscount>
        </price>
        <div className="text-white"></div>
        <button className="">Details</button>
      </div>
    </Link>
  ) : null;
}
