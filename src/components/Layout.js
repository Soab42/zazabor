import React, { useEffect, useState } from "react";
import Login from "./Login";
import { NavLink, Link } from "react-router-dom";
import { cart } from "../product/cartlist";
import Mode from "./Mode";

export default function Layout({ children }) {
  const [cartdata, setCartdata] = useState(cart);
  useEffect(() => {
    setCartdata(cart);
  }, []);
  return (
    <div className="">
      <div className="fixed w-screen  h-12 bg-slate-300 flex justify-between pl-2 pr-2 items-center">
        <logo className="text-blue-600 text-4xl  font-sansfont-extralight">
          <Link to={"/"}>zazbor</Link>
        </logo>
        <nav className="flex gap-2 capitalize font-thin h-full items-center">
          <NavLink to={"/"}>home</NavLink>
          <NavLink to={"/cart"}>cart</NavLink>
          <NavLink to={"/user"}>Contact</NavLink>
        </nav>

        <user className="flex gap-3">
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
