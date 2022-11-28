import React, { useEffect, useState } from "react";
import { cart } from "../product/cartlist";
import Cartline from "./Cartline";

export default function Cart() {
  const [cartobject, setCartobject] = useState([]);
  useEffect(() => {
    setCartobject(cart);
  }, []);
  console.log(cart.values([0]));
  return (
    <div className="bg-pink-200 w-full text-center capitalize">
      <div className="text-lg font-thin bg-slate-500 text-white ">
        this is cart section
      </div>

      <div className="list  text-sm font-thin">
        <table className="w-full">
          <thead>
            <th className=" ">sl</th>
            <th className=" ">name</th>
            <th className=" ">price</th>
            <th className=" ">counter</th>
            <th className=" ">amount</th>
            <th className=" ">action</th>
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
