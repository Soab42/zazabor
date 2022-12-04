import React, { useEffect, useState } from "react";
import Login from "./Login";
import { NavLink, Link } from "react-router-dom";
import { cart } from "../product/cartlist";
import Mode from "./Mode";
import Clock from "./Clock";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { app } from "../firebase";
import Logout from "./Logout";
import CardGiftcardIcon from "@mui/icons-material/CardGiftcard";
import { List, MenuOpen } from "@mui/icons-material";
import { MenuList } from "@mui/material";
export default function Layout({ children }) {
  const [cartdata, setCartdata] = useState(cart);
  const [currentUser, setCurrentUser] = useState();
  const [submenu, setSubmenu] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => {
    setCartdata(cart);
  }, []);
  useEffect(() => {
    const auth = getAuth(app);
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });

    return unsubscribe;
  }, []);
  const usermennu = () => {
    !submenu ? setSubmenu(true) : setSubmenu(false);
  };
  return (
    <div className="overflow-hidden  dark:bg-slate-800 dark:text-slate-300 ">
      <div
        className="fixed w-screen  h-12 bg-slate-200 dark:bg-teal-500 flex justify-between pl-2 pr-2 dark:text-slate-700 items-center"
        style={{ zIndex: "1000" }}
      >
        {/* logo ........................ */}
        <div
          className="md:hidden duration-700"
          onClick={() => (!show ? setShow(true) : setShow(false))}
        >
          {!show ? (
            <MenuOpen fontSize="large" color="action" />
          ) : (
            <List fontSize="large" />
          )}
        </div>
        <logo className=" text-4xl  font-sansfont-extralight">
          <Link to={"/"}>zazabor</Link>
        </logo>
        {/* navigation............................. */}
        <nav
          className="bg-transparent backdrop-blur-sm w-1/2 absolute h-screen top-12 left-0 duration-700 md:hidden"
          style={!show ? { translate: "-18rem" } : null}
          onClick={() => setShow(false)}
        >
          <div
            className="grid text-blue-300 text-center capitalize"
            onClick={() => setShow(false)}
          >
            <NavLink
              className={"shadow-sm shadow-black p-1 hover:bg-slate-700"}
              to={"/"}
            >
              home
            </NavLink>
            <NavLink
              className={"shadow-sm shadow-black p-1 hover:bg-slate-700"}
              to={"/cart"}
            >
              cart
            </NavLink>
            <NavLink
              className={"shadow-sm shadow-black p-1 hover:bg-slate-700"}
              to={"/carosel"}
            >
              Contact
            </NavLink>
            <NavLink
              className={"shadow-sm shadow-black p-1 hover:bg-slate-700"}
              to={"/admin"}
            >
              Add Product
            </NavLink>
            <NavLink
              className={"shadow-sm shadow-black p-1 hover:bg-slate-700"}
              to={"/productlist"}
            >
              Product List
            </NavLink>
          </div>
        </nav>
        <nav className="md:flex hidden gap-2 capitalize font-thin h-full items-center">
          <NavLink to={"/"}>home</NavLink>
          <NavLink to={"/cart"}>cart</NavLink>
          <NavLink to={"/carosel"}>Contact</NavLink>
          <NavLink to={"/admin"}>Add Product</NavLink>
          <NavLink to={"/productlist"}>Product List</NavLink>
        </nav>
        {/* right section ................................. */}

        <user className="flex gap-3  items-center ">
          {/* clock.................. */}
          <div>
            <Clock />
          </div>

          {/* cart................. */}
          <div className="flex relative">
            <div className="z-10">
              <CardGiftcardIcon color="error" />
            </div>
            <div className="absolute w-4 h-4  rounded-full text-black -right-2 -top-1  backdrop-blur-sm text-sm text-center flex items-center justify-center font-thin z-0">
              {cartdata.length > 0 ? cartdata.length : null}
            </div>
          </div>
          {/* user....................... */}
          <div className="items-center flex justify-center">
            {currentUser ? (
              <>
                <div onClick={usermennu} className="capitalize">
                  {!currentUser.photoURL ? (
                    !currentUser.displayName ? (
                      currentUser.email
                    ) : (
                      currentUser.displayName
                    )
                  ) : (
                    <img
                      className="h-12 w-12 p-2 rounded-full"
                      src={`/${currentUser.photoURL}`}
                      alt=""
                    />
                  )}
                </div>
                <div
                  onClick={() => setSubmenu(false)}
                  className="absolute  right-1 top-10"
                  style={!submenu ? { display: "none" } : { display: "grid" }}
                >
                  <div className="bg-slate-400 ring-1 ring-black px-1">
                    <Link to={"/profile"}>profile</Link>
                  </div>
                  <div className="ring-1 ring-black px-1  bg-slate-400">
                    <Logout />
                  </div>
                </div>
              </>
            ) : (
              <Mode name={"Login"}>
                <Login />
              </Mode>
            )}
          </div>
        </user>
      </div>
      }
      <div
        className="pt-14 p-2"
        onClick={() => {
          setSubmenu(false);
          setShow(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
