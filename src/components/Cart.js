import React, { useEffect, useState } from "react";
import { cart } from "../product/cartlist";
import Cartline from "./Cartline";

export default function Cart() {
  const [cartobject, setCartobject] = useState([]);
  useEffect(() => {
    setCartobject(cart);
  }, []);
  return (
    <div className="bg-pink-200 w-96 text-center capitalize">
      <div className="text-lg font-thin bg-slate-500 text-white ">
        this is cart section
      </div>

      <div className="list  text-sm">
        <table className="w-full">
          <thead>
            <th className="ring-1 ">sl</th>
            <th className="ring-1 ">name</th>
            <th className="ring-1">price</th>
            <th className="ring-1 w-32">counter</th>
            <th className="ring-1 ">amount</th>
            <th className="ring-1 ">action</th>
          </thead>
          {cartobject.map((x, index) => (
            <Cartline
              name={x.name}
              index={index}
              price={x.price}
              pieace={x.pieace}
            />
          ))}
        </table>
      </div>
    </div>
  );
}
