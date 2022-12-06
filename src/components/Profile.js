import {
  getAuth,
  updateEmail,
  updatePassword,
  updateProfile,
} from "firebase/auth";
import React, { useEffect, useRef, useState } from "react";
import { app } from "../firebase";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
export default function Profile() {
  const inputref = useRef();
  const auth = getAuth(app);
  const user = auth.currentUser;
  const [name, setName] = useState(`${user.displayName}`);
  const [email, setEmail] = useState(`${user.email}`);
  const [pass, setPass] = useState();
  const [pic, setPic] = useState(`${user.photoURL}`);
  const [nedit, setNedit] = useState(true);
  const [eedit, setEedit] = useState(true);
  const [pedit, setPedit] = useState(true);
  console.log(user);
  const updatename = () => {
    updateProfile(auth.currentUser, {
      displayName: name,
    })
      .then(() => alert("name updated"))
      .catch((error) => alert(error));
  };
  const updatepic = () => {
    updateProfile(auth.currentUser, {
      photoURL: pic,
    })
      .then(() => alert("photo updated"))
      .catch((error) => alert(error));
  };
  const updateemail = () => {
    updateEmail(auth.currentUser, email)
      .then(() => alert("email updated"))
      .catch((error) => alert(error));
  };
  const updatepass = () => {
    updatePassword(auth.currentUser, pass)
      .then(() => alert("password updated"))
      .catch((error) => alert(error));
  };
  return (
    <div className="grid gap-5">
      {/* <div>Profile Informaiton</div> */}
      <div className="grid gap-2">
        <p className="bg-slate-600 h-8 text-center">
          Basic Profile Informaiton
        </p>
        <div className="flex gap-1 justify-between text-white  text-center">
          <p className="shadow-sm backdrop-blur-xl h-8 shadow-white  w-1/3">
            Name
          </p>
          <input
            className="shadow-sm backdrop-blur-xl h-8 shadow-white outline-none w-1/2 text-center bg-inherit"
            value={name}
            disabled={nedit}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="gap-2 w-1/4 flex justify-around">
            <div
              onClick={() => {
                !nedit ? setNedit(true) : setNedit(false);
              }}
              className={"flex gap-2"}
            >
              <DriveFileRenameOutlineIcon />
              <p>Edit</p>
            </div>
            <div onClick={updatename} className={"flex gap-2 text-green-400"}>
              <CheckCircleIcon />
              <p className="hidden md:flex">Update</p>
            </div>
          </div>
        </div>
        <div className="flex gap-1 justify-between text-white  text-center">
          <p className="shadow-sm backdrop-blur-xl h-8 shadow-white  w-1/3 ">
            Email
          </p>
          <input
            className="shadow-sm backdrop-blur-xl h-8 shadow-white  outline-none text-center w-1/2  bg-inherit"
            value={email}
            disabled={eedit}
            autoFocus
            ref={inputref}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div className="gap-2 w-1/4 flex justify-around">
            <div
              onClick={() => {
                !eedit ? setEedit(true) : setEedit(false);
              }}
              className={"flex gap-2"}
            >
              <DriveFileRenameOutlineIcon />
              <p>Edit</p>
            </div>
            <div onClick={updateemail} className={"flex gap-2 text-green-400"}>
              <CheckCircleIcon />
              <p className="hidden md:flex">Update</p>
            </div>
          </div>
        </div>
        <div className="flex gap-1 justify-between text-white  text-center">
          <p className="shadow-sm backdrop-blur-xl h-8 shadow-white  w-1/3 ">
            Password
          </p>
          <input
            className="shadow-sm backdrop-blur-xl h-8 shadow-white  outline-none text-center w-1/2  bg-inherit"
            value={pass}
            disabled={pedit}
            onChange={(e) => setPass(e.target.value)}
          />
          <div className="gap-2 w-1/4 flex justify-around">
            <div
              onClick={() => {
                !eedit ? setPedit(true) : setPedit(false);
              }}
              className={"flex gap-2"}
            >
              <DriveFileRenameOutlineIcon />
              <p>Edit</p>
            </div>
            <div onClick={updatepass} className={"flex gap-2 text-green-400"}>
              <CheckCircleIcon />
              <p className="hidden md:flex">Update</p>
            </div>
          </div>
        </div>
      </div>
      {/* <div>Profile Picture Update</div> */}
      <div>
        <div className="">
          <p className="bg-slate-600 h-8 text-center">Profile picture Update</p>
          <div className="flex items-center gap-2">
            <img
              className="h-36 w-36 p-2 rounded-full"
              src={`/${pic}`}
              alt=""
            />
            <input
              type={"file"}
              onChange={(x) => setPic(x.target.files[0].name)}
            />
            <div
              onClick={updatepic}
              className="flex p-1 bg-slate-500 capitalize font-thin text-green-400"
            >
              <CheckCircleIcon />
              <p>update</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
