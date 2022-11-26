import React, { useState, useEffect } from "react";
import { cart } from "../product/cartlist";

export default function Cartline({ index, name, price, pieace }) {
  const [count2, setCount2] = useState(pieace);

  useEffect(() => {
    count2 > 0 ? setCount2(count2) : setCount2(1);
  }, [count2]);
  const del = () => {
    cart.splice(index, index + 1);
  };
  return (
    <tr className="">
      <td className="ring-1 ">{index + 1}</td>
      <td className="ring-1 ">{name}</td>
      <td className="ring-1 ">{price}</td>
      <td className="ring-1 ">
        <counter className="">
          <button
            className="btn w-8 text-sm shadow-sm shadow-black"
            onClick={() => setCount2(count2 - 1)}
          >
            -
          </button>
          <input
            className="outline-none w-8 h-5 text-sm text-center shadow-sm shadow-black"
            value={count2}
            onChange={(x) => {
              setCount2(Number(x.target.value));
            }}
          />

          <button
            className="btn w-8 text-sm shadow-sm  shadow-black"
            onClick={() => setCount2(count2 + 1)}
          >
            +
          </button>
        </counter>
      </td>
      <td className="ring-1">{count2 * price}$</td>
      <td className="h-full m-0 p-0 bg-red-300 ring-1  hover:bg-red-500">
        <div onClick={del}>x</div>
      </td>
    </tr>
  );
}
