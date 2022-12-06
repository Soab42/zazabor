import React, { useRef, useState } from "react";
import { getDatabase, ref, set } from "firebase/database";
export default function Addproduct() {
  const id = useRef();

  const [catagory, setcatagory] = useState();
  const [name, setname] = useState();
  const price = useRef();
  const discount = useRef();
  const image = useRef();
  const db = getDatabase();
  const dataref = ref(db, "productlist/" + catagory + "/" + name);

  const submit = (e) => {
    e.preventDefault();
    const data = {
      id: id.current.value,
      name: name,
      price: price.current.value,
      catagory: catagory,
      discount: discount.current.value,
      imgUrl: image.current.value,
    };
    set(dataref, data)
      .then((data) => {
        //success callback
        alert("success" + data);
      })
      .catch((error) => {
        //error callback
        alert("failed" + error);
      });
  };
  return (
    <div className="grid justify-center gap-4 text-center">
      <div className="bg-green-200 text-black">Add Product</div>

      <form className="grid gap-4  justify-center" onSubmit={submit}>
        <label className="flex gap-2 justify-between  items-center">
          <p>product id</p>
          <input
            ref={id}
            className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
          />
        </label>
        <label className="flex gap-2 justify-between  items-center">
          <p>product name</p>
          <input
            onChange={(v) => setname(v.target.value)}
            className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
          />
        </label>
        <label className="flex gap-2 justify-between  items-center">
          <p>product catagory </p>
          <input
            onChange={(v) => setcatagory(v.target.value)}
            className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
          />
        </label>
        <label className="flex gap-2 justify-between  items-center">
          <p>product price</p>
          <input
            type={"number"}
            ref={price}
            className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black appearance-none"
          />
        </label>
        <label className="flex gap-2 justify-between  items-center appearance-none">
          <p>product discount</p>
          <input
            type={"number"}
            ref={discount}
            className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
          />
        </label>

        <label className="flex gap-2 justify-between  items-center">
          <p>product image</p>
          <input
            ref={image}
            type={"file"}
            className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
          />
        </label>
        <button type="submit" className="bg-green-300 text-black">
          Add product
        </button>
      </form>
    </div>
  );
}
