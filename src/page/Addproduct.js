import React, { useRef } from "react";
import { getDatabase, push, ref } from "firebase/database";
export default function Addproduct() {
  const id = useRef();
  const name = useRef();
  const catagory = useRef();
  const price = useRef();
  const discount = useRef();
  const image = useRef();
  const db = getDatabase();
  const dataref = ref(db, "productlist");
  console.log(dataref);
  const submit = (e) => {
    e.preventDefault();
    const data = {
      id: id.current.value,
      name: name.current.value,
      price: price.current.value,
      catagory: catagory.current.value,
      discount: discount.current.value,
      imgUrl: image.current.value,
    };
    push(dataref, data)
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
            ref={name}
            className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
          />
        </label>
        <label className="flex gap-2 justify-between  items-center">
          <p>product catagory </p>
          <input
            ref={catagory}
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
