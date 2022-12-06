import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getDatabase, query, ref, get, update } from "firebase/database";
import { app } from "../firebase";

export default function Editproduct() {
  const { key, key2 } = useParams();
  const [product, setProduct] = useState([]);
  const [id, setid] = useState();
  const [name, setname] = useState();
  const [catagory, setcatagory] = useState();
  const [price, setprice] = useState();
  const [discount, setdiscount] = useState();
  // const [image, setimage] = useState();
  const db = getDatabase();
  const dataref = ref(db, "productlist/" + key + "/" + key2);

  useEffect(() => {
    async function fetchProducts() {
      // database related works
      const db = getDatabase(app);
      const prodRef = ref(db, "productlist/" + key);
      const prodQuery = query(prodRef);

      try {
        // request firebase database
        const snapshot = await get(prodQuery);

        if (snapshot.exists()) {
          setProduct(Object.values(snapshot.val()));
        }
      } catch (err) {
        console.log(err);
      }
    }

    fetchProducts();
  }, [key]);
  useEffect(() => {
    product.map((x) => {
      setid(x.id);
      setcatagory(x.catagory);
      setdiscount(x.discount);
      setprice(x.price);
      setname(x.name);
    });

    // setimage(product.image);
  }, [product]);
  const submit = (e) => {
    e.preventDefault();
    const data = {
      id: id,
      name: name,
      price: price,
      catagory: catagory,
      discount: discount,
      // imgUrl: image,
    };
    update(dataref, data)
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
    <div>
      <div className="grid justify-center gap-4 text-center">
        <div className="bg-green-200 text-black">Edit Product</div>

        <form className="grid gap-4  justify-center" onSubmit={submit}>
          <label className="flex gap-2 justify-between  items-center">
            <p>product id</p>
            <input
              value={id}
              onChange={(v) => setid(v.target.value)}
              className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
            />
          </label>
          <label className="flex gap-2 justify-between  items-center">
            <p>product name</p>
            <input
              value={name}
              onChange={(v) => setname(v.target.value)}
              className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
            />
          </label>
          <label className="flex gap-2 justify-between  items-center">
            <p>product catagory </p>
            <input
              value={catagory}
              onChange={(v) => setcatagory(v.target.value)}
              className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
            />
          </label>
          <label className="flex gap-2 justify-between  items-center">
            <p>product price</p>
            <input
              value={price}
              onChange={(v) => setprice(v.target.value)}
              type={"number"}
              className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black appearance-none"
            />
          </label>
          <label className="flex gap-2 justify-between  items-center appearance-none">
            <p>product discount</p>
            <input
              value={discount}
              onChange={(v) => setdiscount(v.target.value)}
              type={"number"}
              className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
            />
          </label>

          {/* <label className="flex gap-2 justify-between  items-center">
            <p>product image</p>
            <input
              value={image}
              onChange={(v) => setimage(v.target.value)}
              type={"file"}
              className="outline-none pl-2 font-thin text-sm bg-inherit shadow-sm shadow-black"
            />
          </label> */}
          <button type="submit" className="bg-green-300 text-black">
            Update product
          </button>
        </form>
      </div>
    </div>
  );
}
