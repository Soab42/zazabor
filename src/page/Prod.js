import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";

import { cart } from "../product/cartlist";
import { productlist } from "../product/productname";
import Middle from "./Middle";
export default function Prod() {
  const { id } = useParams();
  const product = productlist[Number(id)];
  const [count, setCount] = useState(1);
  const [cartdata, setCartdata] = useState([]);
  const price = product.price - (product.price * product.discount) / 100;
  const add = () => {
    cartdata ? cart.push(cartdata) : cart.push(null);
  };
  const listid2 = productlist.length - 1 > id ? Number(id) + 1 : 0;
  const listid = 1 > id ? productlist.length - 1 : Number(id) - 1;
  useEffect(() => {
    count > 0 ? setCount(count) : setCount(1);
    setCartdata({ name: product.name, price: price, pieace: count });
  }, [count, cartdata, price, product.name]);
  return (
    <>
      <div className="flex">
        <div className="w-1/3 p-2" style={{ height: "80vh" }}>
          <img
            className="image ring-2 ring-black shadow-lg shadow-black"
            src={product.image}
            alt={product.name}
          />
        </div>
        <div className="w-1/3">
          <h1 className="text-3xl font-thin text-blue-800 uppercase">
            {product.name}
          </h1>
          <p className="font-bold pt-2 pb-2 capitalize">product key feature</p>
          <div className="grid gap-2">
            {product.feature
              ? product.feature.map((x) => (
                  <div className=" bg-transparent backdrop:blur-xl p-1 shadow-sm shadow-gray-300">
                    {x.title}
                  </div>
                ))
              : null}
          </div>
          <div className="w-full h-16 bg-slate-400 text-white font-bold text-center grid mt-10">
            <price className="p-1 bg-red-300">
              Main Price: {product.price}$
            </price>
            <price className=" bg-green-300 text-black p-1">
              Discount Price:{price} $
            </price>
          </div>
          <div className="mt-5 flex">
            <counter className="">
              <button
                className="btn w-10 text-xl shadow-sm shadow-black"
                onClick={() => setCount(count - 1)}
              >
                -
              </button>
              <input
                className="outline-none w-10 h-7 text-xl text-center shadow-sm  shadow-black"
                value={count}
                onChange={(x) => {
                  setCount(Number(x.target.value));
                }}
              />

              <button
                className="btn w-10 text-xl shadow-sm  shadow-black"
                onClick={() => setCount(count + 1)}
              >
                +
              </button>
            </counter>
            <cart
              onClick={add}
              className="text-xm w-40 h-8 flex  hover:bg-green-400 hover:shadow-md
               cursor-pointer  bg-blue-400 justify-center p-1 ml-5 shadow-md shadow-black rounded-2xl duration-700"
            >
              Add to cart
            </cart>
          </div>
          <div className="flex w-full justify-between capitalize">
            <Link
              to={`/product/${listid}`}
              className="text-xm w-20 h-8 flex  hover:bg-green-400 hover:shadow-md
               cursor-pointer  bg-blue-400 justify-center p-1 ml-5 shadow-md shadow-black rounded-2xl duration-700"
            >
              prev
            </Link>
            <Link
              to={`/product/${listid2}`}
              className="text-xm w-20 h-8 flex  hover:bg-green-400 hover:shadow-md
               cursor-pointer  bg-blue-400 justify-center p-1 ml-5 shadow-md shadow-black rounded-2xl duration-700"
            >
              next
            </Link>
          </div>
        </div>
      </div>

      <div>
        <Middle />
      </div>
    </>
  );
}
