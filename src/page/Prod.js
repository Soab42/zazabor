import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { imagelist } from "../product/img";

import { cart } from "../product/cartlist";
import { productlist } from "../product/productname";
import Middle from "./Middle";

export default function Prod() {
  const { id } = useParams();
  const product = productlist[Number(id)];
  const [count, setCount] = useState(1);
  const [cartdata, setCartdata] = useState([]);
  const [index, setIndex] = useState(0);
  const price = product.price - (product.price * product.discount) / 100;
  const add = () => {
    cartdata ? cart.push(cartdata) : cart.push(null);
  };
  const listid2 = productlist.length - 1 > id ? Number(id) + 1 : 0;
  const listid = 1 > id ? productlist.length - 1 : Number(id) - 1;
  useEffect(() => {
    count > 0 ? setCount(count) : setCount(1);
    setCartdata({ name: product.name, price: price, pieace: count });
  }, [count, cartdata, price, product.name, index]);
  return (
    <>
      <div className="w-full md:flex gap-3 ">
        {/* image section............ */}
        <div className=" md:w-3/5 p-1 md:h-96 relative ">
          <div className=" w-full p-1 h-96 overflow-hidden -z-40">
            <img
              className="w-full object-contain  shadow-md h-full hover:scale-150  duration-700 "
              src={imagelist[index]}
              alt={product.name}
            />
          </div>
          <div className="overflow-hidden m-1">
            <div
              className="overflow-scroll h-12 
              w-4/5 gap-2 md:ml-20 sm:ml-16 ml-10
            flex p-1"
            >
              {/* left button carosel */}
              <div
                onClick={() => {
                  setIndex(index < 1 ? imagelist.length - 1 : index - 1);
                }}
                className="absolute h-10  w-10 text-white ring-1 text-center pt-3 pl-3 md:left-5 -left-1 hover:ring-pink-600 hover:rotate-180 duration-700 rounded-full"
              >
                <div className="h-2 rounded-lg rotate-45 w-4 bg-black dark:bg-white"></div>
                <div className="h-2 -rotate-45 rounded-lg bg-pink-600   w-4"></div>
              </div>
              {/* right button carosel */}

              <div
                onClick={() => {
                  setIndex(index > imagelist.length - 2 ? 0 : index + 1);
                }}
                className="absolute h-10 ring-1  w-10 text-white  md:right-5 -right-1 text-center pt-3 pl-3 hover:ring-pink-600 rotate-180 rounded-full hover:rotate-0 duration-700"
              >
                <div className="h-2 rounded-lg rotate-45 w-4 bg-black dark:bg-white"></div>
                <div className="h-2 -rotate-45 rounded-lg bg-pink-600  w-4 "></div>
              </div>
              {imagelist.map((x, index) => (
                <img
                  className="image hover:opacity-70 object-cover ring-2 ring-black"
                  src={x}
                  alt=""
                  onClick={() => setIndex(index)}
                />
              ))}
            </div>
          </div>
          <div className="md:flex grid justify-around ">
            <zoom className=" dark:text-white p-1 text-center flex justify-between px-2 font-thin shadow-sm gap-1">
              zoom :
              <div className="hover:opacity-60 shadow-sm shadow-teal-800 px-2">
                100
              </div>
              <div className="hover:opacity-60 shadow-sm shadow-teal-800 px-2">
                200
              </div>
              <div className="hover:opacity-60 shadow-sm shadow-teal-800 px-2">
                300
              </div>
            </zoom>
            <move className="p-1  text-center flex font-thin shadow-sm gap-1">
              move :
              <div className="hover:opacity-60 shadow-sm shadow-teal-800 px-2">
                left
              </div>
              <div className="hover:opacity-60 shadow-sm shadow-teal-800 px-2">
                right
              </div>
              <div className="hover:opacity-60 shadow-sm shadow-teal-800 px-2">
                top
              </div>
              <div className="hover:opacity-60 shadow-sm shadow-teal-800 px-2">
                bottom
              </div>
            </move>
          </div>
        </div>
        {/* product title section............ */}

        <div className="md:w-1/3">
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
          {/* priceing.................................. */}
          <div className="w-full p-1 bg-teal-400 text-white font-bold text-center grid mt-5 overflow-hidden justify-center">
            <div className=" grid gap-2 justify-between p-1">
              {/* size setiings............... */}
              <div className="flex font-thin gap-2 w-96  ">
                <button
                  type="radio"
                  className=" w-1/4 backdrop-blur-lg shadow-md uppercase text-sm text-black "
                  value={36}
                >
                  sm
                </button>
                <button className=" w-1/4 backdrop-blur-lg shadow-md text-black uppercase text-sm ">
                  m
                </button>
                <button className=" w-1/4 backdrop-blur-lg shadow-md uppercase text-sm  text-black">
                  xl
                </button>
                <button className=" w-1/4 uppercase text-sm  backdrop-blur-lg shadow-md text-black">
                  xxl
                </button>
              </div>
              {/* color selection............... */}
              <div>
                <div className="flex font-thin gap-2">
                  <button type="radio" className=" w-1/4 bg-black text-black ">
                    -
                  </button>
                  <button className=" h-full w-1/4 bg-pink-400 text-pink-400">
                    -
                  </button>
                  <button className=" w-1/4 bg-red-500 "></button>
                  <button className=" w-1/4 bg-green-400 text-black"></button>
                </div>
              </div>
            </div>
            <price className="p-1 backdrop-blur-lg shadow-md text-black hover:opacity-50">
              Main Price: {product.price}$
            </price>
            <price className="p-1 backdrop-blur-lg shadow-md text-black hover:opacity-50">
              Discount Price:{price}$
            </price>
          </div>
          <div className="mt-5 flex justify-between mb-4">
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
               cursor-pointer  bg-blue-400 justify-center p-1  shadow-md shadow-black rounded-2xl duration-700"
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
      {/* detail section...................... */}
      <div className="mt-5">
        <Middle />
      </div>
    </>
  );
}
