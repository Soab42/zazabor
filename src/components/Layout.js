import React, { useEffect, useState } from "react";
import Login from "./Login";
import { NavLink, Link } from "react-router-dom";
import { cart } from "../product/cartlist";
import Mode from "./Mode";
import Clock from "./Clock";
export default function Layout({ children }) {
  const [cartdata, setCartdata] = useState(cart);
  useEffect(() => {
    setCartdata(cart);
  }, []);
  return (
    <div className="overflow-hidden  dark:bg-slate-800 dark:text-slate-300">
      <div
        className="fixed w-screen  h-12 bg-slate-200 dark:bg-teal-500 flex justify-between pl-2 pr-2 dark:text-slate-700 items-center"
        style={{ zIndex: "1000" }}
      >
        <logo className=" text-4xl  font-sansfont-extralight">
          <Link to={"/"}>zazabor</Link>
        </logo>
        <nav className="flex gap-2 capitalize font-thin h-full items-center">
          <NavLink to={"/"}>home</NavLink>
          <NavLink to={"/cart"}>cart</NavLink>
          <NavLink to={"/carosel"}>Contact</NavLink>
        </nav>

        <user className="flex gap-3">
          <div>
            <Clock />
          </div>
          <div>Cart({cartdata.length})</div>
          <div>
            <Mode name={"Login"}>
              <Login />
            </Mode>
          </div>
        </user>
      </div>
      <div className="pt-14 p-2">{children}</div>
    </div>
  );
}
